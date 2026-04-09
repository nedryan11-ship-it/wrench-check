import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// Public client (anon key) — for client-side reads only.
// RLS applies. Never use for server-side writes.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side admin client — bypasses RLS.
// Use ONLY in API routes and server-side lib functions, never in "use client" components.
// Requires SUPABASE_SERVICE_ROLE_KEY in .env.local (not NEXT_PUBLIC_ prefixed).
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseAnonKey;
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
