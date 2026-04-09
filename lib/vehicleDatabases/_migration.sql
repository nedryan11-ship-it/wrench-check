-- Migration: Create vdb_cache table for VehicleDatabases API response caching
-- Run this in your Supabase SQL editor (Dashboard → SQL Editor → New Query)
--
-- Cache keys:
--   maintenance:{vin}                        → maintenance schedule (30-day TTL)
--   repair:{vin}                             → repair estimates (7-day TTL)

CREATE TABLE IF NOT EXISTS vdb_cache (
  cache_key   text        PRIMARY KEY,
  data        jsonb       NOT NULL,
  cached_at   timestamptz NOT NULL DEFAULT now()
);

-- No user data stored here — disable RLS so server-side anon key can read/write
ALTER TABLE vdb_cache DISABLE ROW LEVEL SECURITY;

-- Index for TTL cleanup queries
CREATE INDEX IF NOT EXISTS vdb_cache_cached_at_idx ON vdb_cache (cached_at);
