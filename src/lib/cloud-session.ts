import { createClient } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { CloudStorage } from './cloud-storage';

export const cloudStorageEnabled = import.meta.env.VITE_CLOUD_STORAGE_ENABLED === 'true';
export async function connectUserClient(expectedOwner: string) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session || data.session.user.id !== expectedOwner) throw new Error('Your account changed or session expired. Sign in and retry.');
  const client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${data.session.access_token}` },
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) }),
    },
  });
  return client;
}
export async function connectCloudStorage(expectedOwner: string): Promise<CloudStorage> {
  if (!cloudStorageEnabled) throw new Error('Cloud storage is disabled. The local library is still available.');
  return new CloudStorage(await connectUserClient(expectedOwner), expectedOwner);
}
