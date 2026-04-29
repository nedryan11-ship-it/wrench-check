// Run the advisor sessions migration via Supabase admin client
const { supabaseAdmin } = require('../lib/supabase');

async function migrate() {
  // Check if tables exist first
  const { data: check, error: checkErr } = await supabaseAdmin
    .from('advisor_sessions')
    .select('id')
    .limit(1);

  if (!checkErr) {
    console.log('✅ advisor_sessions table already exists');
    
    const { error: msgCheck } = await supabaseAdmin
      .from('advisor_messages')
      .select('id')
      .limit(1);
    
    if (!msgCheck) {
      console.log('✅ advisor_messages table already exists');
      console.log('Migration not needed!');
      return;
    }
  }

  console.log('⚠️  Tables do not exist yet.');
  console.log('Please run this SQL in your Supabase SQL Editor:');
  console.log('');
  console.log('File: migrations/003_advisor_sessions.sql');
  console.log('');
  console.log('Or paste this directly:');
  console.log(`
CREATE TABLE IF NOT EXISTS advisor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text DEFAULT 'New conversation',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  summary text,
  vehicle_refs text[],
  is_active boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS advisor_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES advisor_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  files jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advisor_messages_session ON advisor_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_advisor_sessions_active ON advisor_sessions(is_active, updated_at DESC);

ALTER TABLE advisor_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON advisor_sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for service role" ON advisor_messages FOR ALL USING (true) WITH CHECK (true);
  `);
}

migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
