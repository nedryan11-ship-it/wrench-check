// lib/vehicleDatabases/client.ts
// Base HTTP client for VehicleDatabases API.
// All calls are server-side only. Raw API shapes never leave this directory.
// Caching: two layers — in-process Map (instant) + Supabase (persistent).

import { supabase } from "../supabase";

const BASE_URL = "https://api.vehicledatabases.com";
const DEV = process.env.NODE_ENV === "development";

// TTLs
const MAINTENANCE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REPAIR_TTL_MS = 7 * 24 * 60 * 60 * 1000;        // 7 days

// In-process cache (keyed by cacheKey)
const memCache = new Map<string, { data: unknown; cachedAt: number }>();

// ─── Low-level GET ────────────────────────────────────────────────────────────

export async function vdbGet<T>(path: string): Promise<T | null> {
  const apiKey = process.env.VEHICLEDATABASES_API_KEY;
  if (!apiKey) {
    console.error("[VDB] VEHICLEDATABASES_API_KEY is not set");
    return null;
  }

  if (DEV) console.log(`[VDB] GET ${path}`);

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "x-authkey": apiKey },
      next: { revalidate: 0 }, // never cache at Next.js layer
    });

    if (!res.ok) {
      console.error(`[VDB] ${path} → HTTP ${res.status}`);
      return null;
    }

    const json = await res.json();
    if (json?.status !== "success") {
      console.error(`[VDB] ${path} → API error:`, json);
      return null;
    }

    return json.data as T;
  } catch (err) {
    console.error(`[VDB] ${path} → fetch error:`, err);
    return null;
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

export async function getCached<T>(key: string, ttlMs: number): Promise<T | null> {
  // 1. Check in-process cache first
  const mem = memCache.get(key);
  if (mem && Date.now() - mem.cachedAt < ttlMs) {
    if (DEV) console.log(`[VDB cache] HIT (memory) → ${key}`);
    return mem.data as T;
  }

  // 2. Check Supabase cache
  try {
    const { data, error } = await supabase
      .from("vdb_cache")
      .select("data, cached_at")
      .eq("cache_key", key)
      .single();

    if (!error && data) {
      const cachedAt = new Date(data.cached_at).getTime();
      if (Date.now() - cachedAt < ttlMs) {
        if (DEV) console.log(`[VDB cache] HIT (supabase) → ${key}`);
        // Warm in-process cache
        memCache.set(key, { data: data.data, cachedAt });
        return data.data as T;
      }
    }
  } catch {
    // Supabase table may not exist yet — silent fallback
  }

  if (DEV) console.log(`[VDB cache] MISS → ${key}`);
  return null;
}

export async function setCached(key: string, data: unknown): Promise<void> {
  // 1. Write to in-process cache
  memCache.set(key, { data, cachedAt: Date.now() });

  // 2. Write to Supabase (best-effort)
  try {
    await supabase.from("vdb_cache").upsert({
      cache_key: key,
      data,
      cached_at: new Date().toISOString(),
    });
  } catch {
    // Silent — in-memory cache still works
  }
}

export { MAINTENANCE_TTL_MS, REPAIR_TTL_MS, DEV };
