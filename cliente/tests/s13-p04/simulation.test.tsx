import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISSUE_LABEL } from '../../src/features/exchange/copy';
import { showMetric } from '../../src/features/simulation/copy';
import { claimKey, clearSimulationMemory, markUncertain, releaseHeld } from '../../src/features/simulation/memory';
import { buildVersion, sameComparison, versionProblem, type VersionInput } from '../../src/features/simulation/model';
import { SimulationScreen } from '../../src/features/simulation/Simulation';
import { emptyHypothesis, type HypothesisDraft } from '../../src/features/simulation/types';
import { AuthProvider } from '../../src/shared/auth';
import type { Me } from '../../src/shared/contracts';

const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';

function person(roles: string[]): Me {
  return { authState: 'ACTIVE', userId: actorId, organizationId: roles.includes('SA') ? undefined : orgId, roleIds: roles, profile: { displayName: 'Persona sintética', email: 'persona@example.test', emailVerified: true } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const policy = {
  schemaVersion: '1.0.0', simulationPolicy: 'S12-SIMULATION-1.0', alertPolicy: 'S12-ALERTS-1.0', usage: 'LOCAL_SYNTHETIC', realUseAllowed: false,
  scenarioKinds: ['PRUDENT', 'BASE', 'FAVORABLE'], alternativeKinds: ['HOLD_CASH', 'DEBT_PREPAYMENT', 'NEW_LOAN', 'ASSET_PURCHASE'],
  alertTypes: ['LOAN_DUE', 'SCENARIO_DEFICIT'], horizonMaxDays: 366, freshnessSeconds: 300,
  defaultAlertThresholds: { dueWithinDays: 7, concentrationThreshold: '25.00' },
};

function install(role = 'T') {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith('/auth/csrf')) return json({ data: { csrfToken: 'csrf-fixture' }, requestId: 'req' });
    if (path.endsWith('/auth/me')) return json({ data: person([role]), requestId: 'req' });
    if (path.endsWith('/me/personal/book')) return json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'No se encontró.', details: null }, requestId: 'req' }, 404);
    if (path.includes('/simulation-s12/policy')) {
      if (role === 'C') return json({ error: { code: 'ACCESS_DENIED', message: 'No se pudo completar la solicitud.', details: null }, requestId: 'req' }, 403);
      return json({ data: policy, requestId: 'req' });
    }
    return json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'No se encontró.', details: null }, requestId: 'req' }, 404);
  }));
}

afterEach(() => { sessionStorage.clear(); localStorage.clear(); vi.unstubAllGlobals(); clearSimulationMemory(); });

function filled(patch: Partial<HypothesisDraft> = {}): HypothesisDraft {
  return { ...emptyHypothesis(), collectionFraction: '0.5', delayDays: '0', recoveryFraction: '0', recoveryDelayDays: '0', interestProjection: 'DECLARED_SCHEDULE_ONLY', ...patch };
}

function input(creating = true): VersionInput {
  return {
    asOf: '2026-10-31', name: 'Hipotesis sintetica', horizonDays: '30', budget: '0.00', creating, eventIds: { 'BASE:out': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'BASE:in': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    hypotheses: {
      PRUDENT: filled({ collectionFraction: '0.5', delayDays: '5' }),
      BASE: filled({ collectionFraction: '0.8', capitalOutDate: '2026-11-16', capitalOutAmount: '20000001.00', capitalInDate: '2026-11-28', capitalInAmount: '30000000.00', sourceReference: 'SIN-SOPORTE-OFICIAL' }),
      FAVORABLE: filled({ collectionFraction: '1' }),
    },
  };
}

describe('S13-P04 simulation form', () => {
  it('requires explicit fractions and does not configure a loan or a purchase', () => {
    expect(versionProblem({ ...input(), hypotheses: { ...input().hypotheses, PRUDENT: emptyHypothesis() } })).toMatch(/fracción explícita/);
    const body = buildVersion({ ...input(), baseId: '11111111-1111-4111-8111-111111111111', baseToken: 'token' });
    expect(body?.assumptions.find(item => item.kind === 'BASE')?.capitalEvents.map(item => item.date)).toEqual(['2026-11-16', '2026-11-28']);
    expect(body?.alternatives.filter(item => item.configured).map(item => item.kind)).toEqual(['HOLD_CASH']);
    expect(body?.alternatives.filter(item => !item.configured).every(item => item.reason === 'NOT_CONFIGURED')).toBe(true);
    expect(sameComparison({ baseId: 'a', sourceDigest: 'b', horizonDays: 30 }, { baseId: 'c', sourceDigest: 'b', horizonDays: 30 })).toBe(false);
  });

  it('shows an incomplete amount as unavailable and never as zero', () => {
    expect(showMetric({ value: null, status: 'INCOMPLETE', reasons: ['PARTIAL_COVERAGE'], knownPartial: null })).toBe('No disponible (PARTIAL_COVERAGE)');
    expect(showMetric({ value: null, status: 'INCOMPLETE', reasons: [], knownPartial: null })).not.toContain('0');
    expect(showMetric({ value: '10.00', status: 'NOT_APPLICABLE', reasons: [], knownPartial: null })).toBe('NA');
  });

  it('keeps the S11 glyph, extra header and external key visible', () => {
    expect(ISSUE_LABEL['PDF_ESCAPED_UNICODE_V1']).toMatch(/glifo/);
    expect(ISSUE_LABEL['EXTRA_HEADER_CELL']).toMatch(/encabezado/);
    expect(ISSUE_LABEL['EXTERNAL_KEY_CONFLICT']).toMatch(/clave externa/);
  });
});

describe('S13-P04 simulation memory', () => {
  it('reuses one key for the same acknowledgement and blocks another while it is uncertain', () => {
    const first = claimKey('ack:1');
    markUncertain();
    expect(claimKey('ack:1')).toBe(first);
    expect(() => claimKey('ack:2')).toThrow(/sin resultado confirmado/);
    releaseHeld();
  });
});

describe('S13-P04 simulation screen', () => {
  it('marks the surface as simulation and does not offer to apply a scenario', async () => {
    install();
    render(<AuthProvider><SimulationScreen /></AuthProvider>);
    expect(await screen.findByRole('heading', { name: 'Simulación' })).toBeInTheDocument();
    expect(await screen.findByText(/Uso real permitido: no/)).toBeInTheDocument();
    expect(screen.getByText(/no es dinero disponible hoy/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /aplicar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calcular hipótesis' })).toBeDisabled();
    expect(JSON.stringify(sessionStorage).toLowerCase()).not.toContain('simulation');
  });

  it('does not open the tray for platform administration', async () => {
    install('SA');
    render(<AuthProvider><SimulationScreen /></AuthProvider>);
    expect(await screen.findByText(/administración de plataforma/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capturar base' })).not.toBeInTheDocument();
  });

  it('shows the access error for a collaborator and no personal alert', async () => {
    install('C');
    render(<AuthProvider><SimulationScreen /></AuthProvider>);
    expect(await screen.findByText(/No tienes permiso para esta acción/)).toBeInTheDocument();
    expect(screen.queryByText(/alerta personal/i)).not.toBeInTheDocument();
  });
});
