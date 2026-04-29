-- Migration: add offer_log, notes, carfax_data to watchlist_vehicles
-- Run this in your Supabase SQL Editor

ALTER TABLE watchlist_vehicles
  ADD COLUMN IF NOT EXISTS offer_log   jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS notes       text  DEFAULT '',
  ADD COLUMN IF NOT EXISTS carfax_data jsonb DEFAULT '{}'::jsonb;

-- Also widen the status CHECK to allow 'focus' (new tier) alongside existing values
ALTER TABLE watchlist_vehicles
  DROP CONSTRAINT IF EXISTS watchlist_vehicles_status_check;

ALTER TABLE watchlist_vehicles
  ADD CONSTRAINT watchlist_vehicles_status_check
  CHECK (status IN ('watching', 'focus', 'purchased', 'passed'));
