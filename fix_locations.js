const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf8').split('\n').reduce((acc, line) => {
  const [k, v] = line.split('=');
  if (k && v) acc[k] = v.trim();
  return acc;
}, {});

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function fix() {
  const { data: vehicles } = await supabase.from('watchlist_vehicles').select('id, location, make, model');
  const badLocs = ['St. Louis, MO', 'Wichita, KS', 'Richardson, TX', 'Kansas City, MO'];
  
  for (const v of vehicles) {
    if (badLocs.includes(v.location)) {
      console.log(`Fixing ${v.make} ${v.model} (${v.location}) -> Denver, CO`);
      await supabase.from('watchlist_vehicles').update({ location: 'Denver, CO' }).eq('id', v.id);
    }
  }
}
fix().catch(console.error);
