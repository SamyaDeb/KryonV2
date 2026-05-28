import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// Persist incoming order intent from the frontend to the DB.
// The off-chain matcher will pick these up and settle fills on-chain.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      owner: string;
      market_id: number;
      is_long: boolean;
      size: string;
      limit_price: string;
      reduce_only: boolean;
      nonce: string;
      expiry_ts: string;
    };

    const sql = db();

    // Auto-create Account row if this is a new trader (FK required)
    await sql`
      INSERT INTO "Account" (address, collateral, "cancelledNonces", "filledByNonce", "createdAt", "updatedAt")
      VALUES (${body.owner}, '{}', ARRAY[]::BIGINT[], '{}', NOW(), NOW())
      ON CONFLICT (address) DO NOTHING
    `;

    // Upsert — safe to resubmit same nonce
    await sql`
      INSERT INTO "Order" (
        id, owner, "marketId", "isLong", size, "limitPrice",
        "reduceOnly", nonce, "expiryTs", cancelled, "filledSize",
        "createdAt", "updatedAt"
      ) VALUES (
        ${body.owner + ':' + body.nonce},
        ${body.owner},
        ${body.market_id},
        ${body.is_long},
        ${body.size},
        ${body.limit_price},
        ${body.reduce_only},
        ${BigInt(body.nonce)},
        ${BigInt(body.expiry_ts)},
        false,
        '0',
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
