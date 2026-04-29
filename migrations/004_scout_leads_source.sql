-- Add source tracking to scout_leads
-- Run this in Supabase SQL Editor

ALTER TABLE public.scout_leads ADD COLUMN IF NOT EXISTS source text DEFAULT 'unknown';
CREATE INDEX IF NOT EXISTS scout_leads_source_idx ON public.scout_leads(source);
