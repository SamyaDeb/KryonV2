#!/usr/bin/env tsx
import { neon } from "@neondatabase/serverless";

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const result = await sql`
    DELETE FROM "TxJob" WHERE kind = 'settle_fill' AND status = 'QUEUED'
    RETURNING id
  `;
  console.log(`Deleted ${result.length} stale TxJob(s)`);
}

main().catch(console.error);
