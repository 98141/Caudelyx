import {clearDraft as clearPaymentsDraft} from '../features/lending/payments-draft';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clearActivationLink } from './activation-link';
import { bindSessionLost, bumpSessionEpoch, call, refreshCsrf, resetSessionMemory } from './api';
import { ApiError, DiscardedRequest, isStrong, type Me, type SessionMeta } from './contracts';
import { clearFlash } from './flash';
import type { SessionClock } from './session-activity';

interface AuthValue {
  me: Me | null;
  phase: 'loading' | 'anonymous' | 'ready' | 'offline';
  online: boolean;
  clock: SessionClock | null;
  logoutNotice: string | null;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
  expire: () => void;
  retryLogout: () => Promise<void>;
  applySession: (session: SessionMeta) => void;
}

const AuthContext = createContext<AuthValue | null>(null);
const CHANNEL = 'caudelyx-mej-session';
const TAB_INSTANCE = crypto.randomUUID();
const LOGOUT_PENDING = 'caudelyx-logout-pending'; // Boolean only: no account, credential or business data.
function pendingMarker(value?: boolean): boolean {
  try { if (value === true) sessionStorage.setItem(LOGOUT_PENDING, '1'); else if (value === false) sessionStorage.removeItem(LOGOUT_PENDING); return sessionStorage.getItem(LOGOUT_PENDING) === '1'; } catch { return false; }
}
function broadcast(type: string) { if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(CHANNEL); channel.postMessage({type, source:TAB_INSTANCE}); channel.close(); } }

export function replaceHash(hash: string): void {
  const next = new URL(window.location.href);
  next.hash = hash;
  window.history.replaceState(null, '', next);
  if (window.location.hash !== hash) window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function rememberClock(data: Me | null, receivedAt: number): SessionClock | null {
  if (!data?.session) return null;
  return { meta: data.session, receivedAt };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [phase, setPhase] = useState<AuthValue['phase']>('loading');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [clock, setClock] = useState<SessionClock | null>(null);
  const [logoutNotice, setLogoutNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingLogout = useRef(false);
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  const applyIdentity = useCallback((data: Me | null, ticket: number) => {
    if (ticket !== generation.current || pendingLogout.current) return;
    setMe(data);
    setClock(rememberClock(data, Date.now()));
    setPhase(data ? 'ready' : 'anonymous');
  }, []);

  const refresh = useCallback(async () => {
    if (pendingLogout.current) return null;
    const ticket = ++generation.current;
    try {
      await refreshCsrf();
      const result = await call<Me>('GET', '/auth/me');
      if (ticket !== generation.current || pendingLogout.current) return null;
      applyIdentity(result.data, ticket);
      return result.data;
    } catch (error) {
      if (ticket !== generation.current || error instanceof DiscardedRequest || pendingLogout.current) return null;
      resetSessionMemory();
      setMe(null);
      setClock(null);
      if (error instanceof ApiError && error.code === 'OFFLINE') setPhase('offline');
      else setPhase('anonymous');
      return null;
    }
  }, [applyIdentity]);

  const forget = useCallback((notice: string | null) => {
    generation.current += 1;
    bumpSessionEpoch();
    clearActivationLink();
    clearPaymentsDraft();
    sessionStorage.removeItem('caudelyx.s07.collections.draft');
    resetSessionMemory();
    clearFlash();
    setMe(null);
    setClock(null);
    setPhase('anonymous');
    setLogoutNotice(notice);
  }, []);

  const expire = useCallback(() => {
    forget('La sesión venció. Ingresa de nuevo.');
    replaceHash('#/ingresar');
    if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel(CHANNEL); channel.postMessage({ type: 'logout', source:TAB_INSTANCE }); channel.close(); }
  }, [forget]);

  const logout = useCallback(async () => {
    pendingLogout.current = true;
    pendingMarker(true);
    forget('Confirmando el cierre de sesión…');
    replaceHash('#/ingresar?salida=pendiente');
    broadcast('logout-unconfirmed');
    try {
      await call('POST', '/auth/logout');
      pendingLogout.current = false;
      pendingMarker(false);
      setLogoutNotice(null);
      replaceHash('#/ingresar');
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(CHANNEL);
        channel.postMessage({ type: 'logout', source:TAB_INSTANCE });
        channel.close();
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        pendingLogout.current = false;
        pendingMarker(false);
        setLogoutNotice(null);
        replaceHash('#/ingresar');
        return;
      }
      setLogoutNotice('No se pudo confirmar el cierre en el servidor. Reintentar');
      replaceHash('#/ingresar?salida=pendiente');
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(CHANNEL);
        channel.postMessage({ type: 'logout-unconfirmed', source:TAB_INSTANCE });
        channel.close();
      }
    }
  }, [forget]);

  const retryLogout = useCallback(async () => {
    pendingLogout.current = true;
    forget(logoutNotice);
    try {
      await call('POST', '/auth/logout');
      pendingLogout.current = false;
      pendingMarker(false);
      broadcast('logout');
      setLogoutNotice(null);
      replaceHash('#/ingresar');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        pendingLogout.current = false;
        pendingMarker(false);
      broadcast('logout');
        setLogoutNotice(null);
        replaceHash('#/ingresar');
        return;
      }
      setLogoutNotice('No se pudo confirmar el cierre en el servidor. Reintentar');
      replaceHash('#/ingresar?salida=pendiente');
    }
  }, [forget, logoutNotice]);

  useEffect(() => {
    const pending = pendingMarker() || window.location.hash.includes('salida=pendiente');
    if (pending) {
      pendingLogout.current = true;
      replaceHash('#/ingresar?salida=pendiente');
      setPhase('anonymous');
      setLogoutNotice('No se pudo confirmar el cierre en el servidor. Reintentar');
      return;
    }
    void refresh();
  }, [refresh]);

  useEffect(() => {
    bindSessionLost(code => {
      if (!meRef.current) return;
      pendingLogout.current = true;
      forget(code === 'SESSION_EXPIRED'
        ? 'La sesión venció. Ingresa de nuevo.'
        : 'La sesión ya no es válida. Ingresa de nuevo.');
      replaceHash('#/ingresar');
      pendingLogout.current = false;
    });
    return () => bindSessionLost(null);
  }, [forget]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<{ type?: string; source?: string }>) => {
      if (event.data?.source === TAB_INSTANCE) return;
      if (event.data?.type === 'logout' || event.data?.type === 'logout-unconfirmed') {
        pendingLogout.current = true;
        pendingMarker(event.data.type === 'logout-unconfirmed');
        forget(event.data.type === 'logout-unconfirmed'
          ? 'No se pudo confirmar el cierre en el servidor. Reintentar'
          : null);
        replaceHash(event.data.type === 'logout-unconfirmed' ? '#/ingresar?salida=pendiente' : '#/ingresar');
        if (event.data.type === 'logout') pendingLogout.current = false;
        return;
      }
      if (event.data?.type === 'login' && !pendingLogout.current) void refresh();
    };
    return () => channel.close();
  }, [forget, refresh]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const applySession = useCallback((session: SessionMeta) => {
    if (pendingLogout.current || !session?.serverNow) return;
    setClock({ meta: session, receivedAt: Date.now() });
    setMe(current => current ? { ...current, session } : current);
  }, []);

  const value = useMemo(() => ({
    me, phase, online, clock, logoutNotice, refresh, logout, expire, retryLogout, applySession,
  }), [me, phase, online, clock, logoutNotice, refresh, logout, expire, retryLogout, applySession]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('AuthProvider missing');
  return value;
}

export function businessAllowed(me: Me | null): boolean {
  return isStrong(me) && (me?.authState === 'ACTIVE' || me?.authState === 'WORKING');
}

export function announceLogin(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ type: 'login', source:TAB_INSTANCE });
  channel.close();
}
