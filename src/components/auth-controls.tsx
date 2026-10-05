import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { readAuthError, supabase } from '../lib/supabase';
import './auth-controls.css';

export function AuthControls({ beforeSignIn, returnTo }: { beforeSignIn: () => Promise<void>; returnTo?: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(readAuthError);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    if (!supabase) return;
    let authEventReceived = false;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventReceived = true;
      if (active.current) { setUser(session?.user ?? null); setLoading(false); }
    });
    void supabase.auth.getSession().then(({ data: sessionData, error: sessionError }) => {
      if (!active.current) return;
      if (sessionError) setError(`Could not restore sign-in: ${sessionError.message}`);
      if (!authEventReceived) setUser(sessionData.session?.user ?? null);
      setLoading(false);
    }).catch(() => { if (active.current) { setLoading(false); setError('Could not connect to authentication. Try again.'); } });
    return () => { active.current = false; data.subscription.unsubscribe(); };
  }, []);

  async function signIn() {
    if (!supabase || busy) return;
    setBusy(true); setError(null);
    try {
      // Validate the provider before leaving the workbench (avoids a raw Supabase error page).
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
      });
      if (!response.ok) throw new Error('Could not check GitHub login. Try again shortly.');
      const settings = await response.json();
      if (!settings.external?.github) throw new Error('GitHub login is not enabled yet. Enable GitHub in Supabase Authentication → Providers.');
      const { data, error: authError } = await supabase.auth.signInWithOAuth({
        provider: 'github', options: { redirectTo: returnTo ?? window.location.origin, skipBrowserRedirect: true, scopes: 'read:user user:email' },
      });
      if (authError) throw authError;
      if (!data.url) throw new Error('GitHub did not provide a sign-in URL.');
      await beforeSignIn();
      window.location.assign(data.url);
    } catch (e) { if (active.current) { setError((e as Error).message); setBusy(false); } }
  }
  async function signOut() {
    if (!supabase || busy) return;
    setBusy(true); setError(null);
    try {
      const { error: authError } = await supabase.auth.signOut({ scope: 'local' });
      if (authError) throw authError;
      setUser(null);
    } catch (e) { setError(`Sign-out failed: ${(e as Error).message}`); }
    finally { if (active.current) setBusy(false); }
  }
  const name = typeof user?.user_metadata.user_name === 'string' ? user.user_metadata.user_name : user?.email || 'Signed in';
  return <div className="auth-controls">
    {user ? <><span className="account-name" title={name}>@{name}</span><button className="auth-button" disabled={busy} onClick={() => void signOut()}>{busy ? 'Signing out…' : 'Sign out'}</button></> : <button className="auth-button" disabled={!supabase || loading || busy} title={!supabase ? 'Configure VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to enable sign-in.' : 'Sign in through GitHub'} onClick={() => void signIn()}>{loading ? 'Checking session…' : busy ? 'Opening GitHub…' : 'Sign in with GitHub'}</button>}
    {error && <div className="auth-error" role="alert"><span>{error}</span><button aria-label="Dismiss sign-in error" onClick={() => setError(null)}>×</button></div>}
  </div>;
}
