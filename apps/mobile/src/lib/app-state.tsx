import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Bootstrap } from '@slopbot/contracts';
import { api, setMobileAccessToken } from './api';
import { clearVercelSession, restoreVercelSession } from './vercel-auth';

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
    try {
      setData(await api<Bootstrap>('/api/bootstrap'));
      setSignedOut(false);
    } catch (cause) {
      const status = (cause as { status?: number }).status;
      if (status === 401) setSignedOut(true);
      setError(cause instanceof Error ? cause.message : 'Could not load workspace.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void restoreVercelSession().then(refresh); }, [refresh]);

  const signOut = useCallback(async () => {
    await clearVercelSession();
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
