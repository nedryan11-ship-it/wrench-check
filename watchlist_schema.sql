-- Watchlist Table Schema
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS watchlist_vehicles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  
  -- Structured Extracted Data
  title text,
  year integer,
  make text,
  model text,
  trim text,
  mileage integer,
  price integer,
  location text,
  description text,
  owner_count integer,
  has_accident boolean,
  
  -- Price Alert Tracking
  initial_price integer,
  lowest_price integer,
  last_price_check_at timestamp with time zone,
  
  -- Original URLs
  listing_url text UNIQUE NOT NULL,
  
  -- Watchlist Status
  status text DEFAULT 'watching' CHECK (status IN ('watching', 'purchased', 'passed')),
  
  -- WrenchScore Engine Cache (so we don't recalculate on every load)
  score integer,
  tier text,
  tier_label text,
  gem_price_target integer,
  market_mid integer,
  market_price_med integer
);

-- Index for quick lookups by URL
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_listing_url ON watchlist_vehicles(listing_url);

-- RLS Policies
ALTER TABLE watchlist_vehicles ENABLE ROW LEVEL SECURITY;

-- If you don't have user auth yet, allow anon access (for MVP testing only)
CREATE POLICY "Enable read access for all users" ON watchlist_vehicles FOR SELECT USING (true);
CREATE POLICY "Enable insert for anonymously" ON watchlist_vehicles FOR INSERT WITH CHECK (true);
CREATE POLICY "Enable update for anonymously" ON watchlist_vehicles FOR UPDATE USING (true);
