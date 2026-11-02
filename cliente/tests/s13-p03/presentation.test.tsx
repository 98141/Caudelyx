import { describe, expect, it } from 'vitest';
import { outcomeSentence, showMetric } from '../../src/features/simulation/copy';
import { messageFor } from '../../src/shared/contracts';
import type { Metric, Outcome } from '../../src/features/simulation/types';

function metric(value: string | null, reasons: string[] = []): Metric {
  return { value, status: value === null ? 'UNAVAILABLE' : 'COMPLETE', reasons, knownPartial: null };
}

function outcome(partial: Partial<Outcome>): Outcome {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    scenarioKind: 'PRUDENT',
    alternativeKind: 'NEW_LOAN',
    coverage: 'UNAVAILABLE',
    simulability: 'NOT_SIMULABLE',
    reasons: ['INSUFFICIENT_SOURCE'],
    firstDeficitDate: null,
    metrics: { cashFinal: metric(null, ['INSUFFICIENT_SOURCE']), peakDeficit: metric(null, ['INSUFFICIENT_SOURCE']) },
    ...partial,
  };
}

describe('S13-P03 presentation', () => {
  it('keeps an insufficient branch unknown and leaves the other branches readable', () => {
    const hidden = outcomeSentence(outcome({}));
    expect(hidden).toMatch(/la fuente declarada no alcanza en esta rama \(INSUFFICIENT_SOURCE\)/);
    expect(hidden).toMatch(/No es un déficit de cero/);
    expect(hidden).not.toMatch(/0\.00/);
    const kept = outcomeSentence(outcome({
      scenarioKind: 'BASE', alternativeKind: 'NEW_LOAN', coverage: 'COMPLETE', simulability: 'SIMULABLE', reasons: [], firstDeficitDate: null,
      metrics: { cashFinal: metric('10.00') },
    }));
    expect(kept).toMatch(/Simulable/);
    expect(kept).not.toMatch(/No simulable/);
    expect(showMetric(metric(null, ['INSUFFICIENT_SOURCE']))).toBe('No disponible (INSUFFICIENT_SOURCE)');
    expect(showMetric({ value: null, status: 'INCOMPLETE', reasons: ['PARTIAL_COVERAGE'], knownPartial: null })).toBe('No disponible (PARTIAL_COVERAGE)');
  });

  it('shows a real deficit date and does not turn a linked purchase into a client total', () => {
    const deficit = outcomeSentence(outcome({
      scenarioKind: 'BASE', alternativeKind: 'HOLD_CASH', coverage: 'COMPLETE', simulability: 'SIMULABLE', reasons: [], firstDeficitDate: '2026-11-16',
    }));
    expect(deficit).toMatch(/Primer déficit de la hipótesis: 2026-11-16/);
    expect(deficit).toMatch(/No es un movimiento registrado/);
    const purchase = outcome({
      scenarioKind: 'BASE', alternativeKind: 'ASSET_PURCHASE', coverage: 'COMPLETE', simulability: 'SIMULABLE', reasons: [], firstDeficitDate: null,
      metrics: {
        cashMinimum: metric('0.00'), peakDeficit: metric('0.00'), ownDebt: metric('120000000.00'),
        netWorthBook: metric('80000000.00'), netWorthIndicative: metric('100000000.00'),
      },
    });
    expect(outcomeSentence(purchase)).toMatch(/no se sustituye por cero/);
    expect(showMetric(purchase.metrics['ownDebt'])).toBe('120000000.00');
    expect(showMetric(purchase.metrics['peakDeficit'])).toBe('0.00');
  });

  it('names integrity and rate limit without a password or a new write', () => {
    expect(messageFor('INTEGRITY_MISMATCH', 503)).toMatch(/temporalmente no disponible/);
    expect(messageFor('INTEGRITY_MISMATCH', 503)).toMatch(/No es una contraseña incorrecta/);
    expect(messageFor('INTEGRITY_MISMATCH', 409)).toMatch(/No se desembolsó/);
    expect(messageFor('SERVICE_UNAVAILABLE', 503)).toMatch(/no reintenta sola una escritura/);
    expect(messageFor('RATE_LIMITED', 429)).toMatch(/cola está llena/);
    expect(messageFor('RATE_LIMITED', 429)).toMatch(/clave nueva/);
  });
});
