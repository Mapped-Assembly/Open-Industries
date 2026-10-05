import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export const configPath = process.env.ASTRA_CLI_CONFIG || join(process.env.APPDATA || join(homedir(), '.config'), 'Mergence', 'auth.json');
export function loadEnv(root = process.cwd()) {
  for (const file of ['.env', '.env.local']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
export function writeAuth(session) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(session, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  if (platform() !== 'win32') chmodSync(configPath, 0o600);
}
/** @param {{root?: string, signal?: AbortSignal}} options */
export function client(options = {}) {
  loadEnv(options.root);
  const url = process.env.VITE_SUPABASE_URL?.trim();
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new Error('Configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.');
  // A public browser key and the user's session are the only supported authority.
  let role; try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role; } catch {}
  if (key.startsWith('sb_secret_') || role === 'service_role') throw new Error('Use a public Supabase key, never a service-role key.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'pkce' },
    ...(options.signal ? { global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]) }) } } : {}) });
}
/** @param {{root?: string, signal?: AbortSignal}} options */
export async function sessionClient(options = {}) {
  let stored; try { stored = JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
  if (!stored?.access_token || !stored?.refresh_token) throw new Error('Sign in first with "astra auth login".');
  const supabase = client(options);
  const { data, error } = await supabase.auth.setSession({ access_token: stored.access_token, refresh_token: stored.refresh_token });
  if (error || !data.session) throw new Error('Mergence session expired. Run "astra auth login" again.');
  if (data.session.refresh_token !== stored.refresh_token || data.session.access_token !== stored.access_token) writeAuth(data.session);
  const { data: verified, error: userError } = await supabase.auth.getUser();
  if (userError || !verified.user) throw new Error('Mergence account could not be verified. Sign in again.');
  return { supabase, session: data.session, owner: verified.user.id };
}
