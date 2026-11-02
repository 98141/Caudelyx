import type { Metric, Outcome } from './types';

export const KIND_LABEL: Record<string, string> = {
  PRUDENT: 'Prudente',
  BASE: 'Base',
  FAVORABLE: 'Favorable',
};

export const ALTERNATIVE_LABEL: Record<string, string> = {
  HOLD_CASH: 'Ahorro sin reinversión',
  DEBT_PREPAYMENT: 'Abono a deuda',
  NEW_LOAN: 'Préstamo nuevo',
  ASSET_PURCHASE: 'Compra de activo',
};

export const POSITION_LABEL: Record<string, string> = {
  cashBook: 'Saldo de libro',
  available: 'Disponible en la base capturada',
  reserved: 'Reservas',
  held: 'Retenido',
  custodyProvisional: 'Custodia provisional',
  custodyConfirmed: 'Custodia confirmada',
  committed: 'Comprometido',
};

export const METRIC_LABEL: Record<string, string> = {
  cashFinal: 'Caja al cierre de la hipótesis',
  cashMinimum: 'Caja mínima de la hipótesis',
  availableFinal: 'Disponible al cierre de la hipótesis',
  availableMinimum: 'Disponible mínimo de la hipótesis',
  peakDeficit: 'Déficit máximo de la hipótesis',
  principalOutstanding: 'Capital por cobrar',
  expectedInterest: 'Interés de la hipótesis',
  recognizedInterest: 'Interés reconocido',
  cost: 'Costos declarados',
  reserved: 'Reservas',
  ownDebt: 'Deuda',
  estimatedOwnValue: 'Valor estimado',
  netWorthBook: 'Patrimonio de libro',
  netWorthIndicative: 'Valor indicativo',
};

export const ALERT_CLASS_LABEL: Record<string, string> = {
  FACT: 'Hecho observado',
  SCENARIO: 'Advertencia hipotética',
};

const REASON_LABEL: Record<string, string> = {
  INSUFFICIENT_SOURCE: 'la fuente declarada no alcanza en esta rama',
  NOT_CONFIGURED: 'sin configurar',
  PARTIAL_COVERAGE: 'cobertura parcial',
  NO_DENOMINATOR: 'sin denominador',
};

export function reasonText(code: string): string {
  const label = REASON_LABEL[code];
  return label ? `${label} (${code})` : code;
}

export function outcomeSentence(outcome: Outcome): string {
  const kind = KIND_LABEL[outcome.scenarioKind] ?? outcome.scenarioKind;
  const alternative = ALTERNATIVE_LABEL[outcome.alternativeKind] ?? outcome.alternativeKind;
  const reasons = outcome.reasons.map(reasonText).join('; ');
  if (outcome.simulability === 'NOT_SIMULABLE') {
    return `${kind}, ${alternative}. Cobertura no disponible. No simulable. Motivo: ${reasons || 'el servidor no dio un motivo'}. Esta rama no se calculó. No es un déficit de cero y las otras ramas siguen en la lista.`;
  }
  const deficit = outcome.firstDeficitDate
    ? `Primer déficit de la hipótesis: ${outcome.firstDeficitDate}. No es un movimiento registrado.`
    : 'El servidor no señaló fecha de primer déficit. El pico está en la tabla y no se sustituye por cero.';
  const coverage = outcome.coverage === 'COMPLETE' ? 'completa' : outcome.coverage === 'INCOMPLETE' ? 'incompleta' : outcome.coverage === 'UNAVAILABLE' ? 'no disponible' : outcome.coverage;
  const simulability = outcome.simulability === 'SIMULABLE' ? 'Simulable' : outcome.simulability === 'PARTIALLY_SIMULABLE' ? 'Parcialmente simulable' : outcome.simulability;
  return `${kind}, ${alternative}. Cobertura ${coverage}. ${simulability}. ${deficit}${reasons ? ` Motivo: ${reasons}.` : ''}`;
}

export function showMetric(metric: Metric | undefined): string {
  if (!metric || metric.value === null || metric.status === 'UNAVAILABLE' || metric.status === 'NO_DENOMINATOR') {
    const reason = metric?.reasons?.length ? ` (${metric.reasons.join(', ')})` : '';
    return `No disponible${reason}`;
  }
  if (metric.status === 'NOT_APPLICABLE') return 'NA';
  if (metric.status === 'INCOMPLETE') {
    const reason = metric.reasons.length ? ` (${metric.reasons.join(', ')})` : '';
    return `${metric.value} (incompleto${reason})`;
  }
  return metric.value;
}
