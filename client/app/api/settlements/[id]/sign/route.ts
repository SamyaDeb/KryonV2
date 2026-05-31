import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Keypair, StrKey, Transaction, xdr, rpc as sorobanRpc } from "@stellar/stellar-sdk";
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

  if (isMaker) data.makerSignedEntry = body.signedAuthEntry;
  if (isTaker) data.takerSignedEntry = body.signedAuthEntry;

  const bothSigned = !!data.makerSignedEntry && !!data.takerSignedEntry;

  if (!bothSigned) {
    await sql`
      UPDATE "TxJob"
      SET "unsignedXdr" = ${JSON.stringify(data)}, "updatedAt" = NOW()
      WHERE id = ${id}
    `;
    return NextResponse.json({ ok: true, status: "waiting_for_other_party" });
  }

  // Both signed — inject signed auth entries and submit
  try {
    const server = new sorobanRpc.Server(NETWORK.rpcUrl);
    const feePayerSecret = process.env.MATCHER_OPERATOR_SECRET ?? process.env.ORACLE_PUBLISHER_SECRET;
    if (!feePayerSecret) {
      return NextResponse.json({ ok: false, error: "Missing matcher fee-payer secret" }, { status: 500 });
    }
    const feeKp = Keypair.fromSecret(feePayerSecret);

    const envelope = xdr.TransactionEnvelope.fromXDR(data.assembledTxXdr, "base64");
    const ops = envelope.v1().tx().operations();
    if (ops.length > 0) {
      const makerEntry = xdr.SorobanAuthorizationEntry.fromXDR(data.makerSignedEntry!, "base64");
      const takerEntry = xdr.SorobanAuthorizationEntry.fromXDR(data.takerSignedEntry!, "base64");
      ops[0].body().invokeHostFunctionOp().auth([makerEntry, takerEntry]);
    }

    const tx = new Transaction(envelope, NETWORK.passphrase);
    tx.sign(feeKp);

    const send = await server.sendTransaction(tx);
    if (send.status === "ERROR") {
      throw new Error(send.errorResult?.toXDR("base64") ?? "submit error");
    }

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") {
        const ledger = Number("ledger" in poll ? poll.ledger : 0);
        await sql`
          UPDATE "TxJob"
          SET status = 'DONE', "submittedHash" = ${send.hash}, "updatedAt" = NOW()
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
  } catch {
    return NextResponse.json({ ok: false, error: "Settlement submission failed" }, { status: 500 });
  }
}
