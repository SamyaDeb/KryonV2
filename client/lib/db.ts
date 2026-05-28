import { neon } from "@neondatabase/serverless";

// Server-side only — never import this in client components.
// DATABASE_URL is a private env var (no NEXT_PUBLIC_ prefix).
function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

export const db = getDb;
