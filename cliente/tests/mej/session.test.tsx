import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../src/shared/auth';
import { ACTIVITY_DEBOUNCE_MS, deadlineState, shouldSendActivity, useSessionActivity, type SessionClock } from '../../src/shared/session-activity';

function clock(idleMs: number): SessionClock {
  const now = Date.parse('2026-10-25T12:00:00.000Z');
  return {
    receivedAt: now,
    meta: {
      serverNow: new Date(now).toISOString(),
      idleExpiresAt: new Date(now + idleMs).toISOString(),
      absoluteExpiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
      balanceVerifiedUntil: null,
    },
  };
}

function Harness({ stamp }: { stamp: SessionClock }) {
  const activity = useSessionActivity({ enabled: true, clock: stamp, onSession: () => undefined, onExpired: () => undefined });
  return <p>{activity.state?.warning ? 'aviso' : 'quieto'}</p>;
}

describe('MEJ-3 sesión', () => {
  it('no reenvía actividad dentro del minuto', () => {
    expect(ACTIVITY_DEBOUNCE_MS).toBeLessThanOrEqual(60_000);
    expect(shouldSendActivity(1_000, 1_000 + 59_000)).toBe(false);
    expect(shouldSendActivity(1_000, 1_000 + 60_000)).toBe(true);
  });

  it('avisa dentro de los dos minutos y no alarga el tope de 12 horas', () => {
    const soon = deadlineState(clock(90_000), Date.parse('2026-10-25T12:00:00.000Z'));
    expect(soon.warning).toBe(true);
    expect(soon.absoluteBinds).toBe(false);
    const bound = deadlineState({
      receivedAt: Date.parse('2026-10-25T12:00:00.000Z'),
      meta: {
        serverNow: '2026-10-25T12:00:00.000Z',
        idleExpiresAt: '2026-10-25T13:00:00.000Z',
        absoluteExpiresAt: '2026-10-25T12:01:00.000Z',
        balanceVerifiedUntil: null,
      },
    }, Date.parse('2026-10-25T12:00:00.000Z'));
    expect(bound.warning).toBe(true);
    expect(bound.absoluteBinds).toBe(true);
  });

  it('el intervalo local no publica actividad', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-25T12:00:00.000Z'));
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      posts.push(String(input));
      return new Response(JSON.stringify({ data: { csrfToken: 'csrf' }, requestId: 'req' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    render(<AuthProvider><Harness stamp={clock(60 * 60 * 1000)} /></AuthProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(posts.some(path => path.includes('/auth/session/activity'))).toBe(false);
    expect(screen.getByText('quieto')).toBeInTheDocument();
    vi.useRealTimers();
  });
});
