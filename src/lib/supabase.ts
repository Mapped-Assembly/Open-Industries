import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

// Public configuration only. Supabase Auth supplies each user's JWT to the RLS-protected API.
export const supabase = url && key ? createClient(url, key, {
  auth: { flowType: 'pkce', autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
}) : null;

/** Read OAuth errors once and remove authentication parameters from the address bar. */
export function readAuthError(): string | null {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  const error = url.searchParams.get('error_description') || hash.get('error_description') || url.searchParams.get('error') || hash.get('error');
  if (!error) return null;
  for (const name of ['error', 'error_code', 'error_description', 'code']) { url.searchParams.delete(name); hash.delete(name); }
  url.hash = hash.toString();
  history.replaceState(history.state, '', url);
  return `GitHub sign-in was not completed: ${error.replace(/\+/g, ' ').slice(0, 300)}`;
}
