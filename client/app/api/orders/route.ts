import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { validateOrderIntent } from "@/lib/validation";
import { bodyTooLarge, rateLimit, requestKey } from "@/lib/rate-limit";
import { StrKey } from "@stellar/stellar-sdk";

// GET /api/orders?address=G...&limit=50
// Returns the DB state of orders for a wallet address so the frontend can
// sync its local store (status, filledSize) without relying on localStorage alone.
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json([], { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 60))) {
    return NextResponse.json([], { status: 429 });
  }
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10), 100);
  try {
    const sql = db();
    const rows = await sql`
      SELECT id, owner, "marketId", "isLong", size, "limitPrice",
             "reduceOnly", nonce, "expiryTs", cancelled, "filledSize", "createdAt"
      FROM "Order"
      WHERE owner = ${address}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
    const orders = rows.map((r) => ({
      id:         String(r.id),
      owner:      String(r.owner),
      marketId:   Number(r.marketId),
      isLong:     Boolean(r.isLong),
      size:       String(r.size),
      limitPrice: String(r.limitPrice),
      reduceOnly: Boolean(r.reduceOnly),
      nonce:      String(r.nonce),
      expiryTs:   String(r.expiryTs),
      cancelled:  Boolean(r.cancelled),
      filledSize: String(r.filledSize),
      createdAt:  new Date(r.createdAt).getTime(),
    }));
    return NextResponse.json(orders, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}

// Persist incoming order intent from the frontend to the DB.
// The off-chain matcher will pick these up and settle fills on-chain.
export async function POST(req: NextRequest) {
  if (bodyTooLarge(req)) {
    return NextResponse.json({ ok: false, error: "Body too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate before touching the DB — keeps malformed/abusive intents out of
  // the orderbook and the matcher.
  const result = validateOrderIntent(body);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  const o = result.order;
  if (!(await rateLimit(requestKey(req, o.owner), 30))) {
    return NextResponse.json({ ok: false, error: "Too many order requests" }, { status: 429 });
  }

  try {
    const sql = db();

    await withRetry(async () => {
      // Auto-create Account row if this is a new trader (FK required)
      await sql`
        INSERT INTO "Account" (address, collateral, "cancelledNonces", "filledByNonce", "createdAt", "updatedAt")
        VALUES (${o.owner}, '{}', ARRAY[]::BIGINT[], '{}', NOW(), NOW())
        ON CONFLICT (address) DO NOTHING
      `;

      // Upsert — safe to resubmit same nonce
      await sql`
        INSERT INTO "Order" (
          id, owner, "marketId", "isLong", size, "limitPrice",
          "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
          "createdAt", "updatedAt"
        ) VALUES (
          ${o.owner + ":" + o.nonce.toString()},
          ${o.owner},
          ${o.marketId},
          ${o.isLong},
          ${o.size.toString()},
          ${o.limitPrice.toString()},
          ${o.reduceOnly},
          ${o.nonce},
          ${o.expiryTs},
          false,
          '0',
          NOW(),
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    // Log server-side; never leak internal errors to the client.
    console.error("order intake error:", e);
    return NextResponse.json({ ok: false, error: "Failed to persist order" }, { status: 500 });
  }
}
