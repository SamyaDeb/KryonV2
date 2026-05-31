import { NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { ACTIVE_MARKET_SYMBOLS, NETWORK, WS_URL } from "@/config";

export async function GET() {
  try {
    const sql = db();
    await withRetry(async () => {
      await sql`SELECT 1`;
    }, 2);

    return NextResponse.json(
      {
        ok: true,
        network: NETWORK.name,
        markets: ACTIVE_MARKET_SYMBOLS,
        websocketConfigured: Boolean(WS_URL),
        timestamp: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "readiness_unavailable",
        timestamp: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
