import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// Reconstruct live orderbook from resting (unfilled, uncancelled) limit orders.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const marketId = parseInt(id, 10);
  if (!marketId) return NextResponse.json(null, { status: 400 });

  try {
    const sql = db();
    const PRECISION = 1e18;
    const AMOUNT_PRECISION = 1e7;

    // Open resting limit orders: not cancelled, not fully filled, has a limit price
    const rows = await sql`
      SELECT
        "isLong",
        "limitPrice"::numeric  AS limit_price,
        "size"::numeric        AS size,
        "filledSize"::numeric  AS filled_size
      FROM "Order"
      WHERE
        "marketId"   = ${marketId}
        AND cancelled = false
        AND "limitPrice" <> '0'
        AND "filledSize"::numeric < "size"::numeric
      ORDER BY "limitPrice"::numeric ASC
    `;

    // Aggregate into price levels
    const bidMap = new Map<string, number>();
    const askMap = new Map<string, number>();

    for (const row of rows) {
      const priceHuman = (Number(row.limit_price) / PRECISION).toFixed(4);
      const remainingSize = (Number(row.size) - Number(row.filled_size)) / AMOUNT_PRECISION;
      if (row.isLong) {
        bidMap.set(priceHuman, (bidMap.get(priceHuman) ?? 0) + remainingSize);
      } else {
        askMap.set(priceHuman, (askMap.get(priceHuman) ?? 0) + remainingSize);
      }
    }

    // Sort: bids descending (best bid first), asks ascending (best ask first)
    const bids = [...bidMap.entries()]
      .sort((a, b) => parseFloat(b[0]) - parseFloat(a[0]))
      .map(([price, size]) => ({ price, size: size.toFixed(4) }));

    const asks = [...askMap.entries()]
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .map(([price, size]) => ({ price, size: size.toFixed(4) }));

    return NextResponse.json(
      { bids, asks, timestamp: Date.now() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(null, { status: 500 });
  }
}
