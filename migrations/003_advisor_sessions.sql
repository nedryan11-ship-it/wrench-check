-- Advisor Sessions & Messages
-- Run this in the Supabase SQL Editor

-- Sessions table
CREATE TABLE IF NOT EXISTS advisor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text DEFAULT 'New conversation',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  summary text,
  vehicle_refs text[],
  is_active boolean DEFAULT true
);

-- Messages table
CREATE TABLE IF NOT EXISTS advisor_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES advisor_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  files jsonb,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_advisor_messages_session
  ON advisor_messages(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_advisor_sessions_active
  ON advisor_sessions(is_active, updated_at DESC);

-- Disable RLS (single-user app, using service role key)
ALTER TABLE advisor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_messages ENABLE ROW LEVEL SECURITY;

-- Allow all operations via service role
CREATE POLICY "Allow all for service role" ON advisor_sessions
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for service role" ON advisor_messages
  FOR ALL USING (true) WITH CHECK (true);
