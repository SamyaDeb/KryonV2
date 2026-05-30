import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { validateOrderIntent } from "@/lib/validation";

// Persist incoming order intent from the frontend to the DB.
// The off-chain matcher will pick these up and settle fills on-chain.
export async function POST(req: NextRequest) {
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
