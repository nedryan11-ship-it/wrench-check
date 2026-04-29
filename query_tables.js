const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data, error } = await supabase.rpc('get_tables'); // Or just try selecting from some common names
  if (error) {
    // Try querying a table 'kv_store'
    const res1 = await supabase.from('kv_store').select('*').limit(1);
    console.log('kv_store:', res1.error ? flex(res1.error) : 'exists');
    const res2 = await supabase.from('comparisons').select('*').limit(1);
    console.log('comparisons:', res2.error ? flex(res2.error) : 'exists');
    const res3 = await supabase.from('sessions').select('*').limit(1);
    console.log('sessions:', res3.error ? flex(res3.error) : 'exists');
  } else {
    console.log(data);
  }
}
function flex(err) { return err.message || err.code; }
require('dotenv').config({ path: '.env.local' });
run();
