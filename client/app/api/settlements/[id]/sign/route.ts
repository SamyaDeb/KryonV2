import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Keypair, StrKey, TransactionBuilder, xdr, rpc as sorobanRpc } from "@stellar/stellar-sdk";
import { NETWORK } from "@/config";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  if (bodyTooLarge(req, 12_288)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }
  const body = await req.json().catch(() => null);
  if (!body?.signedAuthEntry || !body?.address) {
    return NextResponse.json({ ok: false, error: "Missing signedAuthEntry or address" }, { status: 400 });
  }
  if (typeof body.address !== "string" || !StrKey.isValidEd25519PublicKey(body.address)) {
    return NextResponse.json({ ok: false, error: "Invalid address" }, { status: 400 });
  }
  if (typeof body.signedAuthEntry !== "string" || body.signedAuthEntry.length > 8192) {
    return NextResponse.json({ ok: false, error: "Invalid signed auth entry" }, { status: 400 });
  }
  try {
    xdr.SorobanAuthorizationEntry.fromXDR(body.signedAuthEntry, "base64");
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid signed auth entry" }, { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, body.address), 30))) {
    return NextResponse.json({ ok: false, error: "Too many settlement requests" }, { status: 429 });
  }

  const sql = db();
  const rows = await sql`
    SELECT id, "payloadHash", "unsignedXdr", status
    FROM "TxJob"
    WHERE id = ${id} AND kind = 'settle_fill'
    LIMIT 1
  `;
  if (!rows.length) return NextResponse.json({ ok: false, error: "TxJob not found" }, { status: 404 });

  const job = rows[0];
  if (job.status !== "QUEUED") {
    return NextResponse.json({ ok: false, error: "Already processed" }, { status: 409 });
  }

  let data: {
    makerAddress: string;
    takerAddress: string;
    makerAuthXdr: string;
    takerAuthXdr: string;
    assembledTxXdr: string;
    makerSignedEntry?: string;
    takerSignedEntry?: string;
    fillPrice: string;
    fillSize: string;
    marketId: number;
    pendingTxHash?: string;
    makerNonce?: string;
    takerNonce?: string;
  };

  try {
    data = JSON.parse(job.unsignedXdr as string);
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed TxJob payload" }, { status: 500 });
  }

  if (
    !StrKey.isValidEd25519PublicKey(data.makerAddress) ||
    !StrKey.isValidEd25519PublicKey(data.takerAddress)
  ) {
    return NextResponse.json({ ok: false, error: "Malformed TxJob parties" }, { status: 500 });
  }

  const isMaker = data.makerAddress === body.address;
  const isTaker = data.takerAddress === body.address;
  if (!isMaker && !isTaker) {
    return NextResponse.json({ ok: false, error: "Address not party to this fill" }, { status: 403 });
  }

  // Atomically merge this party's signed entry into the job payload while it is
  // still QUEUED. A single jsonb-concat UPDATE (re-evaluated against the locked
  // row under READ COMMITTED) avoids the lost-update race where maker and taker
  // each read-modify-write the JSON blob and clobber each other's entry.
  const field = isMaker ? "makerSignedEntry" : "takerSignedEntry";
  const merged = await sql`
    UPDATE "TxJob"
    SET "unsignedXdr" = (("unsignedXdr"::jsonb) || ${JSON.stringify({ [field]: body.signedAuthEntry })}::jsonb)::text,
        "updatedAt" = NOW()
    WHERE id = ${id} AND kind = 'settle_fill' AND status = 'QUEUED'
    RETURNING "unsignedXdr"
  `;
  if (!merged.length) {
    // Row is no longer QUEUED — another request already claimed/submitted it.
    return NextResponse.json({ ok: true, status: "already_processing" });
  }
  try {
    data = JSON.parse(merged[0].unsignedXdr as string);
  } catch {
    return NextResponse.json({ ok: false, error: "Malformed TxJob payload" }, { status: 500 });
  }

  if (!data.makerSignedEntry || !data.takerSignedEntry) {
    return NextResponse.json({ ok: true, status: "waiting_for_other_party" });
  }

  // Both entries are present. Claim submission rights atomically: exactly one
  // request wins the QUEUED→SUBMITTED transition and proceeds to broadcast;
  // any concurrent request sees 0 rows and backs off (no double-submit).
  const claim = await sql`
    UPDATE "TxJob"
    SET status = 'SUBMITTED', "updatedAt" = NOW()
    WHERE id = ${id} AND status = 'QUEUED'
    RETURNING id
  `;
  if (!claim.length) {
    return NextResponse.json({ ok: true, status: "submitting" });
  }

  // Both signed — rebuild with fresh fee-payer sequence to avoid stale-sequence rejection.
  // The assembled tx XDR was created at match time; the matcher operator may have submitted
  // other transactions since then, advancing their sequence and making the stored XDR invalid.
  try {
    const server = new sorobanRpc.Server(NETWORK.rpcUrl);
    const feePayerSecret = process.env.MATCHER_OPERATOR_SECRET ?? process.env.ORACLE_PUBLISHER_SECRET;
    if (!feePayerSecret) {
      return NextResponse.json({ ok: false, error: "Missing matcher fee-payer secret" }, { status: 500 });
    }
    const feeKp = Keypair.fromSecret(feePayerSecret);

    // Extract the original operation + Soroban resource data from the stored assembled tx
    const storedEnvelope = xdr.TransactionEnvelope.fromXDR(data.assembledTxXdr, "base64");
    const storedTxBody = storedEnvelope.v1().tx();
    const op = storedTxBody.operations()[0];
    const sorobanData = storedTxBody.ext().sorobanData();

    // Fetch current fee-payer account to get fresh sequence number
    const freshAccount = await server.getAccount(feeKp.publicKey());

    // Rebuild tx with fresh sequence but original op + resource footprint
    const rebuilt = new TransactionBuilder(freshAccount, {
      fee: String(storedTxBody.fee()),
      networkPassphrase: NETWORK.passphrase,
    })
      .addOperation(op)
      .setSorobanData(sorobanData)
      .setTimeout(60)
      .build();

    // Inject signed auth entries into the rebuilt transaction
    const makerEntry = xdr.SorobanAuthorizationEntry.fromXDR(data.makerSignedEntry!, "base64");
    const takerEntry = xdr.SorobanAuthorizationEntry.fromXDR(data.takerSignedEntry!, "base64");
    rebuilt.toEnvelope().v1().tx().operations()[0]
      .body().invokeHostFunctionOp().auth([makerEntry, takerEntry]);

    rebuilt.sign(feeKp);

    const send = await server.sendTransaction(rebuilt);
    if (send.status === "ERROR") {
      throw new Error(send.errorResult?.toXDR("base64") ?? "submit error");
    }

    // Persist the hash immediately so a reconciliation worker can resolve the job
    // even if this request times out before confirmation. Status stays SUBMITTED.
    await sql`
      UPDATE "TxJob" SET "submittedHash" = ${send.hash}, "updatedAt" = NOW() WHERE id = ${id}
    `;

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") {
        const ledger = Number("ledger" in poll ? poll.ledger : 0);
        await sql`
          UPDATE "TxJob"
          SET status = 'CONFIRMED', "submittedHash" = ${send.hash}, "updatedAt" = NOW()
          WHERE id = ${id}
        `;
        if (data.pendingTxHash) {
          await sql`
            UPDATE "Fill"
            SET "txHash" = ${send.hash}, ledger = ${ledger}
            WHERE network = ${NETWORK.name}
              AND "txHash" = ${data.pendingTxHash}
              AND maker = ${data.makerAddress}
              AND taker = ${data.takerAddress}
              AND "makerNonce" = ${data.makerNonce ?? ""}
              AND "takerNonce" = ${data.takerNonce ?? ""}
          `;
        }
        return NextResponse.json({ ok: true, status: "settled", hash: send.hash });
      }
      if (poll.status === "FAILED") {
        await sql`UPDATE "TxJob" SET status = 'FAILED', "updatedAt" = NOW() WHERE id = ${id}`;
        return NextResponse.json({ ok: false, error: "tx failed on-chain" }, { status: 500 });
      }
    }
    return NextResponse.json({ ok: false, error: "timeout" }, { status: 504 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Settlement submission error:", msg);
    // We hold the SUBMITTED claim — mark FAILED with the error so the job is not
    // stranded mid-flight and a reconciliation worker / operator can act on it.
    await sql`
      UPDATE "TxJob" SET status = 'FAILED', "lastError" = ${msg.slice(0, 500)}, "updatedAt" = NOW()
      WHERE id = ${id}
    `.catch(() => {});
    return NextResponse.json({ ok: false, error: `Settlement submission failed: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}
