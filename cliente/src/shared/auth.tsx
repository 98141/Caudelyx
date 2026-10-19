import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { call, refreshCsrf, resetSessionMemory } from './api';
import { ApiError, isStrong, type Me } from './contracts';

interface AuthValue {
  me: Me | null;
  phase: 'loading' | 'anonymous' | 'ready' | 'offline';
  online: boolean;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [phase, setPhase] = useState<AuthValue['phase']>('loading');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  const refresh = useCallback(async () => {
    try {
      await refreshCsrf();
      const result = await call<Me>('GET', '/auth/me');
      setMe(result.data);
      setPhase('ready');
      return result.data;
    } catch (error) {
      resetSessionMemory();
      setMe(null);
      if (error instanceof ApiError && error.code === 'OFFLINE') setPhase('offline');
      else setPhase('anonymous');
      return null;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const logout = useCallback(async () => {
    await call('POST', '/auth/logout');
    resetSessionMemory();
    setMe(null);
    setPhase('anonymous');
  }, []);

  const value = useMemo(() => ({ me, phase, online, refresh, logout }), [me, phase, online, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}

export function businessAllowed(me: Me | null): boolean {
  return isStrong(me) && me?.authState === 'ACTIVE';
}
