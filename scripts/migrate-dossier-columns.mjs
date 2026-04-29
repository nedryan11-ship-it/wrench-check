// scripts/migrate-dossier-columns.mjs
// Run once: node scripts/migrate-dossier-columns.mjs
// Adds the dossier columns needed for the Hunt Intelligence build.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE env vars — make sure .env.local is sourced");
}

const supabase = createClient(supabaseUrl, supabaseKey);

// We use a trick: insert dummy row then catch the column error to detect
// missing columns, OR we try to select a known column.
async function columnExists(table, column) {
  const { data, error } = await supabase.from(table).select(column).limit(1);
  return !error;
}

async function addColumnViaUpsert(tableName) {
  // Check each column and report
  const columns = [
    "confidence_pct",
    "documents",
    "photo_intel",
    "deal_chat",
    "next_steps",
    "adjusted_score",
  ];
  for (const col of columns) {
    const exists = await columnExists(tableName, col);
    console.log(`  ${col}: ${exists ? "✅ already exists" : "❌ MISSING — add manually in Supabase Dashboard"}`);
  }
}

console.log("Checking watchlist_vehicles columns...");
await addColumnViaUpsert("watchlist_vehicles");
console.log("\nDone. For any MISSING columns, run the following SQL in Supabase Dashboard (SQL Editor):");
console.log(`
ALTER TABLE watchlist_vehicles
  ADD COLUMN IF NOT EXISTS confidence_pct   INTEGER DEFAULT 25,
  ADD COLUMN IF NOT EXISTS documents        JSONB   DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS photo_intel      JSONB   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deal_chat        JSONB   DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_steps       JSONB   DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS adjusted_score   INTEGER DEFAULT NULL;
`);
