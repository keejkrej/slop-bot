import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Bootstrap } from '@slopbot/contracts';
import { api, setMobileAccessToken } from './api';
import { authConfigured, getSupabase } from './supabase';

type AppState = {
  data?: Bootstrap;
  loading: boolean;
  signedOut: boolean;
  error?: string;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Bootstrap>();
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setError(undefined);
    try { setData(await api<Bootstrap>('/api/bootstrap')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load workspace.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!authConfigured()) { setMobileAccessToken(null); void refresh(); return; }
    const supabase = getSupabase();
    void supabase.auth.getSession().then(({ data: auth }) => {
      const token = auth.session?.access_token ?? null;
      setMobileAccessToken(token);
      setSignedOut(!token);
      setLoading(false);
      if (token) void refresh();
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      setMobileAccessToken(token);
      setSignedOut(!token);
      if (token) void refresh(); else setData(undefined);
    });
    return () => listener.subscription.unsubscribe();
  }, [refresh]);

  const signOut = useCallback(async () => {
    if (authConfigured()) await getSupabase().auth.signOut();
    setMobileAccessToken(null);
    setData(undefined);
    setSignedOut(true);
  }, []);

  const value = useMemo(() => ({ data, loading, signedOut, error, refresh, signOut }), [data, loading, signedOut, error, refresh, signOut]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider.');
  return value;
}
