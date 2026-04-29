-- WrenchCheck: Price Velocity + Seller Intelligence columns
-- Run this in Supabase SQL Editor > New Query

ALTER TABLE watchlist_vehicles
  ADD COLUMN IF NOT EXISTS price_history   JSONB    DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS seller_name     TEXT,
  ADD COLUMN IF NOT EXISTS days_on_market  INTEGER;

-- Backfill price_history for existing rows that have a price but no history
UPDATE watchlist_vehicles
SET price_history = jsonb_build_array(
  jsonb_build_object(
    'price', price,
    'date',  created_at::text
  )
)
WHERE price IS NOT NULL
  AND (price_history IS NULL OR price_history = '[]'::jsonb);
