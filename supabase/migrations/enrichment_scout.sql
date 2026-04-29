-- WrenchCheck: Enrichment Pipeline + Scout Agent DB Migration
-- Run this in the Supabase SQL Editor

-- ── Enrichment columns on existing watchlist_vehicles ─────────────────────────
ALTER TABLE watchlist_vehicles
  ADD COLUMN IF NOT EXISTS vin              TEXT,
  ADD COLUMN IF NOT EXISTS recalls          JSONB    DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS enrichment_status TEXT   DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS enriched_at      TIMESTAMPTZ;

-- Index for polling enrichment status efficiently
CREATE INDEX IF NOT EXISTS idx_watchlist_enrichment_status
  ON watchlist_vehicles (enrichment_status)
  WHERE enrichment_status = 'pending';

-- ── Scout Configs: user's saved search parameters ─────────────────────────────
CREATE TABLE IF NOT EXISTS scout_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ      DEFAULT now(),
  label         TEXT,                             -- e.g. "Lexus RX Hunt"
  make          TEXT NOT NULL,                    -- e.g. "lexus"
  model         TEXT,                             -- e.g. "rx 350" (null = any)
  year_min      INT,
  year_max      INT,
  price_max     INT,
  mileage_max   INT,
  radius_miles  INT    DEFAULT 500,
  sources       TEXT[] DEFAULT ARRAY['cars.com','bat'],
  is_active     BOOLEAN DEFAULT true,
  last_run_at   TIMESTAMPTZ,
  lead_count    INT    DEFAULT 0
);

-- ── Scout Leads: discovered vehicles awaiting user review ─────────────────────
CREATE TABLE IF NOT EXISTS scout_leads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_at    TIMESTAMPTZ DEFAULT now(),
  scout_config_id  UUID REFERENCES scout_configs(id) ON DELETE CASCADE,
  listing_url      TEXT UNIQUE NOT NULL,
  title            TEXT,
  year             INT,
  make             TEXT,
  model            TEXT,
  trim             TEXT,
  mileage          INT,
  price            INT,
  location         TEXT,
  shadow_score     INT,
  shadow_tier      TEXT,   -- 'gem' | 'watch' | 'pass'
  transit_level    INT,    -- 1–5
  transit_label    TEXT,   -- 'Local' | 'Short Haul' | 'Mid-Haul' | 'Long Haul' | 'Cross Country'
  gem_price_target INT,
  market_mid       INT,
  status           TEXT DEFAULT 'new',  -- 'new' | 'added' | 'dismissed'
  raw_intel        JSONB  -- full ListingIntel blob
);

-- Fast lookups
CREATE INDEX IF NOT EXISTS idx_scout_leads_status    ON scout_leads (status);
CREATE INDEX IF NOT EXISTS idx_scout_leads_score     ON scout_leads (shadow_score DESC);
CREATE INDEX IF NOT EXISTS idx_scout_leads_config    ON scout_leads (scout_config_id);
