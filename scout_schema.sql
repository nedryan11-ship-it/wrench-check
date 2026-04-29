-- scout_schema.sql
-- Run this once in Supabase SQL Editor to enable the Scout product.

-- ── 1. Scout Configurations ─────────────────────────────────────────────────
create table if not exists public.scout_configs (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  make           text not null,
  model          text,
  year_min       int,
  year_max       int,
  price_max      int,
  mileage_max    int,
  radius_miles   int default 500,
  sources        text[] default array['cars.com'],
  is_active      boolean default true,
  lead_count     int default 0,
  last_run_at    timestamptz,
  created_at     timestamptz default now()
);

-- ── 2. Scout Leads ──────────────────────────────────────────────────────────
create table if not exists public.scout_leads (
  id               uuid primary key default gen_random_uuid(),
  scout_config_id  uuid references public.scout_configs(id) on delete cascade,
  vin              text,
  listing_url      text not null,
  title            text,
  year             int,
  make             text,
  model            text,
  trim             text,
  mileage          int,
  price            int,
  location         text,
  shadow_score     int,
  shadow_tier      text,
  transit_level    int,
  transit_label    text,
  gem_price_target int,
  market_mid       int,
  status           text default 'new',   -- 'new' | 'added' | 'dismissed'
  discovered_at    timestamptz default now(),
  raw_intel        jsonb,
  created_at       timestamptz default now()
);

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
create index if not exists scout_leads_status_idx on public.scout_leads(status);
create index if not exists scout_leads_score_idx  on public.scout_leads(shadow_score desc);
create index if not exists scout_leads_vin_idx    on public.scout_leads(vin) where vin is not null;
create unique index if not exists scout_leads_url_idx on public.scout_leads(listing_url);

-- ── 4. RLS (disable for service-role key usage) ──────────────────────────────
alter table public.scout_configs enable row level security;
alter table public.scout_leads   enable row level security;

-- Allow full access via service role (used by API routes via supabaseAdmin)
create policy "Service role full access on scout_configs"
  on public.scout_configs for all
  using (true) with check (true);

create policy "Service role full access on scout_leads"
  on public.scout_leads for all
  using (true) with check (true);
