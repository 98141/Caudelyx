import { useEffect, useRef, useState } from 'react';
import { call } from './api';
import type { SessionMeta } from './contracts';

export const ACTIVITY_DEBOUNCE_MS = 60_000;
export const WARNING_MS = 120_000;

export interface SessionClock {
  meta: SessionMeta;
  receivedAt: number;
}

export function estimatedServerNow(clock: SessionClock, now = Date.now()): number {
  const origin = Date.parse(clock.meta.serverNow);
  if (!Number.isFinite(origin)) return now;
  return origin + (now - clock.receivedAt);
}

export function deadlineState(clock: SessionClock, now = Date.now()) {
  if (!clock?.meta?.serverNow) return { server: now, idle: now, absolute: now, soon: now, expired: false, warning: false, absoluteBinds: false };
  const server = estimatedServerNow(clock, now);
  const idle = Date.parse(clock.meta.idleExpiresAt);
  const absolute = Date.parse(clock.meta.absoluteExpiresAt);
  const soon = Math.min(idle, absolute);
  return {
    server,
    idle,
    absolute,
    soon,
    expired: server >= soon,
    warning: server < soon && soon - server <= WARNING_MS,
    absoluteBinds: absolute <= idle,
  };
}

export function grantActive(clock: SessionClock | null, now = Date.now()): boolean {
  if (!clock?.meta.balanceVerifiedUntil) return false;
  const until = Date.parse(clock.meta.balanceVerifiedUntil);
  return Number.isFinite(until) && deadlineState(clock, now).server < until;
}

export function shouldSendActivity(lastSentAt: number, now: number): boolean {
  return lastSentAt === 0 || now - lastSentAt >= ACTIVITY_DEBOUNCE_MS;
}

export function useSessionActivity(options: {
  enabled: boolean;
  clock: SessionClock | null;
  onSession: (session: SessionMeta) => void;
  onExpired: () => void;
}) {
  const lastSent = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef<Promise<void> | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  async function send(force: boolean) {
    const current = optionsRef.current;
    if (!current.enabled || !current.clock || document.visibilityState === 'hidden') return;
    if (deadlineState(current.clock).expired) { current.onExpired(); return; }
    const stamp = Date.now();
    if (!force && !shouldSendActivity(lastSent.current, stamp)) return;
    lastSent.current = stamp;
    if (inFlight.current) return inFlight.current;
    const pending = (async () => {
      const result = await call<{ session: SessionMeta }>('POST', '/auth/session/activity', {});
      if (optionsRef.current.enabled && result.data?.session?.serverNow) optionsRef.current.onSession(result.data.session);
    })();
    inFlight.current = pending;
    try { await pending; } finally { if (inFlight.current === pending) inFlight.current = null; }
  }

  useEffect(() => {
    if (!options.enabled) return;
    const onInteract = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('[data-session-activity="explicit"]')) return;
      void send(false).catch(() => undefined);
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, onInteract, { passive: true });
    return () => { for (const name of events) window.removeEventListener(name, onInteract); };
  }, [options.enabled]);

  useEffect(() => {
    if (!options.enabled || !options.clock) return;
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !optionsRef.current.clock) return;
      if (deadlineState(optionsRef.current.clock).expired) optionsRef.current.onExpired();
      setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [options.enabled, options.clock]);

  const state = options.clock ? deadlineState(options.clock, now) : null;
  useEffect(() => {
    if (options.enabled && state?.expired) optionsRef.current.onExpired();
  }, [options.enabled, state?.expired]);
  return {
    state,
    stayConnected: () => send(true),
  };
}
