import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

// GET /api/settlements?address=G...
// Returns pending settle_fill jobs where the caller is maker or taker
// and has not yet signed their auth entry.
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) return NextResponse.json([], { status: 400 });

  try {
    const sql = db();
    const rows = await sql`
      SELECT id, "payloadHash", "unsignedXdr", "createdAt"
      FROM "TxJob"
      WHERE kind = 'settle_fill'
        AND status = 'QUEUED'
        AND "unsignedXdr" IS NOT NULL
      ORDER BY "createdAt" DESC
      LIMIT 20
    `;

    const pending = [];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.unsignedXdr as string);
        if (data.makerAddress !== address && data.takerAddress !== address) continue;

        const isMaker = data.makerAddress === address;
        const alreadySigned = isMaker
          ? !!data.makerSignedEntry
          : !!data.takerSignedEntry;

        if (alreadySigned) continue;

        pending.push({
          id:          String(row.id),
          fillHash:    row.payloadHash,
          isMaker,
          makerAddress: data.makerAddress,
          takerAddress: data.takerAddress,
          // The unsigned auth entry this user needs to sign
          authEntryXdr: isMaker ? data.makerAuthXdr : data.takerAuthXdr,
          fillPrice:   data.fillPrice,
          fillSize:    data.fillSize,
          marketId:    data.marketId,
          createdAt:   row.createdAt,
        });
      } catch { /* malformed row — skip */ }
    }

    return NextResponse.json(pending, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json([], {
      status: 500,
      headers: { "X-Error": String(e) },
    });
  }
}
