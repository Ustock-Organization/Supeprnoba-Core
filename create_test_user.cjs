
const { createClient } = require('@supabase/supabase-js');

const fs = require('fs');
const path = require('path');

// Read admin_config.json
const configPath = path.join(__dirname, 'admin_config.json');
let adminConfig;
try {
  adminConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
  // If not found, try getting from Lambda (fallback, but let's assume json exists)
  console.error("Config file not found");
  process.exit(1);
}

const SUPABASE_URL = adminConfig.Environment.Variables.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = adminConfig.Environment.Variables.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function run() {
    const email = 'test-user-1@supernoba.com';
    const password = 'testpassword123';

    // 1. Try to create
    const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
    });

    if (error) {
        if (error.message.includes('already registered')) {
            // Fetch existing
            const { data: list, error: listErr } = await supabase.auth.admin.listUsers();
             const user = list.users.find(u => u.email === email);
             if (user) {
                 console.log("EXISTING_USER_ID:", user.id);
                 return;
             }
        }
        console.error("Error:", error);
        return;
    }
    
    console.log("NEW_USER_ID:", data.user.id);
}

run();
