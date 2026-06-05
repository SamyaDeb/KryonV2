#!/usr/bin/env tsx
import { neon } from "@neondatabase/serverless";
async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  await sql`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS signature TEXT`;
  console.log("✓ Added signature column to Order");
}
main().catch(console.error);
