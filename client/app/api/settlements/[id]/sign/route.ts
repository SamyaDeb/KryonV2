import { NextRequest, NextResponse } from "next/server";

// Settlement is now handled automatically by the matcher fee-payer.
// Individual auth-entry signing is no longer required.
// This endpoint is kept for backwards compatibility but returns a clear message.
export async function POST(
  _req: NextRequest,
  _ctx: { params: Promise<{ id: string }> }
) {
  return NextResponse.json(
    { ok: false, error: "Settlement is now automatic — no user signing required." },
    { status: 410 }
  );
}
