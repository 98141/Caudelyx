import type { Metric } from './types';

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
