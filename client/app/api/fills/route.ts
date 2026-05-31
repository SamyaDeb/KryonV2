import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { db } from "@/lib/db";
import { rateLimit, requestKey } from "@/lib/rate-limit";

const PRICE_SCALE  = 1e18;
const AMOUNT_SCALE = 1e7;

// GET /api/fills?address=G...&since=<unix-ms>&limit=10
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address || !StrKey.isValidEd25519PublicKey(address)) {
    return NextResponse.json([], { status: 400 });
  }
  if (!(await rateLimit(requestKey(req, address), 120))) {
    return NextResponse.json([], { status: 429 });
  }

  const since = req.nextUrl.searchParams.get("since");
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "20", 10), 50);

  try {
    const sql = db();
    const sinceDate = since ? new Date(parseInt(since, 10)) : new Date(Date.now() - 24 * 3600 * 1000);

    const rows = await sql`
      SELECT
        id,
        "marketId"   AS market_id,
        maker,
        taker,
        "makerNonce" AS maker_nonce,
        "takerNonce" AS taker_nonce,
        "fillPrice"  AS fill_price,
        "fillSize"   AS fill_size,
        "txHash"     AS tx_hash,
        "createdAt"  AS created_at
      FROM "Fill"
      WHERE (maker = ${address} OR taker = ${address})
        AND "createdAt" > ${sinceDate}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;

    const fills = rows.map((r) => ({
      id:        String(r.id),
      marketId:  Number(r.market_id),
      isMaker:   r.maker === address,
      price:     (Number(r.fill_price) / PRICE_SCALE).toFixed(4),
      size:      (Number(r.fill_size)  / AMOUNT_SCALE).toFixed(4),
      txHash:    String(r.tx_hash),
      createdAt: new Date(r.created_at).getTime(),
    }));

    return NextResponse.json(fills, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}
