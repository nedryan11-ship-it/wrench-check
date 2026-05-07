-- 1. Fix RLS Vulnerability on Advisor Tables
-- Previously, USING (true) allowed public access if the anon key was exposed.
-- We want to ensure only the service role or authenticated users can access them, 
-- or explicitly disable anon access.
DROP POLICY IF EXISTS "Allow all for service role" ON advisor_sessions;
DROP POLICY IF EXISTS "Allow all for service role" ON advisor_messages;

-- If you are purely using the service_role key on the backend, RLS policies are bypassed entirely by the service_role.
-- However, Supabase still complains if a policy explicitly grants access to the 'anon' role via USING (true).
-- We can create policies that ONLY allow the service_role (which is redundant but satisfies scanners) 
-- or we can just leave RLS enabled with NO policies, which means default deny for anon/authenticated, 
-- while service_role still bypasses it.
-- We will just do a strict policy for authenticated users, just in case.
CREATE POLICY "Deny anon access" ON advisor_sessions FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon access" ON advisor_messages FOR ALL TO anon USING (false);


-- 2. Create the Fix or Sell Reports table for Shareable Links
CREATE TABLE IF NOT EXISTS fos_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz DEFAULT now(),
  vehicle_desc text NOT NULL,
  repair_cost numeric NOT NULL,
  vehicle_value numeric NOT NULL,
  as_is_value numeric NOT NULL,
  repair_roi numeric,
  decision text NOT NULL,
  report_data jsonb NOT NULL, -- stores the full result object for rendering
  views integer DEFAULT 0
);

-- Enable RLS
ALTER TABLE fos_reports ENABLE ROW LEVEL SECURITY;

-- Allow ANYONE to insert a new report (they don't need to be logged in to save their result)
CREATE POLICY "Anyone can insert a fos_report"
  ON fos_reports FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Allow ANYONE to read a report (since UUIDs are unguessable, this allows shareable links)
CREATE POLICY "Anyone can view a fos_report"
  ON fos_reports FOR SELECT
  TO anon, authenticated
  USING (true);
