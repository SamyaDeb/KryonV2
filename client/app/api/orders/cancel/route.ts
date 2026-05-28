import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const { owner, nonce } = await req.json() as { owner: string; nonce: string };
    const sql = db();

    await sql`
      UPDATE "Order"
      SET cancelled = true, "updatedAt" = NOW()
      WHERE owner = ${owner} AND nonce = ${BigInt(nonce)}
    `;

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
