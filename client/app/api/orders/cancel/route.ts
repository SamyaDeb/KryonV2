import { NextRequest, NextResponse } from "next/server";
import { db, withRetry } from "@/lib/db";
import { StrKey } from "@stellar/stellar-sdk";

export async function POST(req: NextRequest) {
  let body: { owner?: unknown; nonce?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const owner = body.owner;
  if (typeof owner !== "string" || !StrKey.isValidEd25519PublicKey(owner)) {
    return NextResponse.json({ ok: false, error: "Invalid owner address" }, { status: 400 });
  }
  const nonceStr = String(body.nonce ?? "");
  if (!/^\d+$/.test(nonceStr)) {
    return NextResponse.json({ ok: false, error: "Invalid nonce" }, { status: 400 });
  }
  const nonce = BigInt(nonceStr);

  try {
    const sql = db();
    await withRetry(() =>
      sql`
        UPDATE "Order"
        SET cancelled = true, "updatedAt" = NOW()
        WHERE owner = ${owner} AND nonce = ${nonce}
      `
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("order cancel error:", e);
    return NextResponse.json({ ok: false, error: "Failed to cancel order" }, { status: 500 });
  }
}
