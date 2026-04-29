const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
(async () => {
   // Wait, supabase-js rpc is only for SQL functions.
   console.log("Use raw sql execution...");
})()
