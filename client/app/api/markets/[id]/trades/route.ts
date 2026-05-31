import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// Prices are stored in 1e18 precision (PRICE_PRECISION).
// Sizes are stored in 1e7 precision (AMOUNT_PRECISION) for real fills,
// or 1e18 for legacy E2E test data — we normalise both to floats here.
const PRICE_SCALE = 1e18;
const AMOUNT_SCALE = 1e7;

function normaliseSize(rawSize: string | number): number {
  const n = Number(rawSize);
  // Heuristic: real amounts (1e7 precision) are < 1e12 for normal trade sizes.
  // E2E test data uses 1e18, so anything ≥ 1e12 is treated as 1e18-scaled.
  return n >= 1e12 ? n / PRICE_SCALE : n / AMOUNT_SCALE;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json([], { status: 400 });

  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10), 200);

  try {
    const sql = db();
    const rows = await sql`
      SELECT
        "fillPrice"::text  AS fill_price,
        "fillSize"::text   AS fill_size,
        "createdAt"        AS ts,
        "makerNonce"::text AS maker_nonce
      FROM "Fill"
      WHERE "marketId" = ${marketId}
      ORDER BY "createdAt" DESC, id DESC
      LIMIT ${limit}
    `;

    const trades = rows.map((r) => ({
      price: (Number(r.fill_price) / PRICE_SCALE).toFixed(4),
      size:  normaliseSize(r.fill_size).toFixed(4),
      // Alternate sides when the taker direction isn't stored (E2E data).
      // Real indexer data should include side; for now use nonce parity.
      side:  (Number(r.maker_nonce) % 2 === 0 ? "buy" : "sell") as "buy" | "sell",
      timestamp: new Date(r.ts).getTime(),
    }));

    return NextResponse.json(trades, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json([], { status: 500 });
  }
}
