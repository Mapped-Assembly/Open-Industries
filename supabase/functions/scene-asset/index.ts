import { createClient } from 'npm:@supabase/supabase-js@2.116.0';
import { sceneAssetHandler } from './handler.mjs';

const url = Deno.env.get('SUPABASE_URL')!;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const reader = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, options);
// This client is used only after the read RPC authorizes the exact revision and
// returns its retained asset version. No caller-supplied object path is accepted.
const storage = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, options).storage;
Deno.serve(sceneAssetHandler(reader, storage));
