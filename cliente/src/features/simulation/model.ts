import type { AlternativeBody, AssumptionBody, CapitalEventBody, HypothesisDraft, ScenarioKind, VersionBody } from './types';
import { ALTERNATIVES, KINDS } from './types';

const FRACTION = /^(0(?:\.[0-9]{1,6})?|1(?:\.0{1,6})?)$/;
const MONEY = /^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface VersionInput {
  asOf: string;
  name: string;
  horizonDays: string;
  budget: string;
  hypotheses: Record<ScenarioKind, HypothesisDraft>;
  creating: boolean;
  eventIds: Record<string, string>;
  alternatives?: AlternativeBody[];
}

function integer(value: string, maximum: number): number | null {
  if (!/^(0|[1-9][0-9]{0,2})$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed > maximum) return null;
  return parsed;
}

function leg(date: string, amount: string, reference: string, asOf: string): string | null {
  const used = date !== '' || amount !== '' || reference !== '';
  if (!used) return null;
  if (!DATE.test(date) || date <= asOf) return 'La fecha declarada tiene que ser posterior a la base.';
  if (!MONEY.test(amount) || amount === '0.00') return 'El importe declarado no es válido. No se envió.';
  if (reference.trim().length < 1 || reference.trim().length > 256) return 'La referencia de la hipótesis es obligatoria. No se inventó un soporte.';
  return null;
}

export function versionProblem(input: VersionInput): string | null {
  if (input.creating && (input.name.trim().length < 1 || input.name.trim().length > 120)) return 'Falta el nombre de la hipótesis.';
  const horizon = integer(input.horizonDays, 366);
  if (horizon === null || horizon < 1) return 'El horizonte tiene que ser un número de días entre 1 y 366.';
  if (!MONEY.test(input.budget)) return 'El presupuesto declarado no es un importe válido. No se envió.';
  for (const kind of KINDS) {
    const row = input.hypotheses[kind];
    if (!FRACTION.test(row.collectionFraction) || !FRACTION.test(row.recoveryFraction)) return `Falta una fracción explícita en ${kind}. No se asumió un recaudo.`;
    if (integer(row.delayDays, 366) === null || integer(row.recoveryDelayDays, 366) === null) return 'El retraso tiene que ser un número de días entre 0 y 366.';
    if (row.interestProjection !== 'DECLARED_SCHEDULE_ONLY' && row.interestProjection !== 'SUPPORTED_SOURCE_TERMS') return 'Elige la proyección de interés. No se autocompletó.';
    const outflow = leg(row.capitalOutDate, row.capitalOutAmount, row.sourceReference, input.asOf);
    const inflow = leg(row.capitalInDate, row.capitalInAmount, row.sourceReference, input.asOf);
    if (outflow) return outflow;
    if (inflow) return inflow;
    for(const d of row.dateOverrides??[])if(!d.sourceKey.trim()||!DATE.test(d.collectionDate)||d.collectionDate<=input.asOf||d.recoveryDate!==null&&(!DATE.test(d.recoveryDate)||d.recoveryDate<d.collectionDate))return 'Revisa la cuota y sus fechas de recaudo y recuperación.';
    const r=row.reinvestment;if(r&&(!r.cashSourceFlowId||!r.sourceReference||leg(r.date,r.amount,r.sourceReference,input.asOf)))return 'La reinversión necesita fecha, importe, fuente de recaudo y declaración explícitas.';
  }
  for(const a of input.alternatives??[]){if(!a.configured)continue;
   if(a.kind!=='HOLD_CASH'&&(!a.date||!DATE.test(a.date)||a.date<=input.asOf))return 'Cada alternativa configurada necesita una fecha posterior a la base.';
   if(a.kind==='DEBT_PREPAYMENT'&&(!a.liabilityId||!a.prepaymentMode))return 'Selecciona la obligación y el modo de abono.';
   if(a.kind==='NEW_LOAN'&&(!a.principal||!MONEY.test(a.principal)))return 'Declara el principal del nuevo préstamo.';
   if(['NEW_LOAN','DEBT_PREPAYMENT'].includes(a.kind)){
    if(!a.terms)return 'Indica términos nativos o un calendario hipotético explícito.';
    if(a.terms.kind==='NATIVE_VERSION'&&(!a.terms.sourceId||!Number.isInteger(a.terms.sourceVersion)||a.terms.sourceVersion<1))return 'Selecciona la fuente y versión de términos vigente.';
    if(a.terms.kind==='DECLARED_HYPOTHESIS'&&(!a.terms.sourceReference.trim()||!MONEY.test(a.terms.principalOpening)||a.terms.installments.length===0||a.terms.installments.some(q=>!DATE.test(q.dueDate)||![q.principal,q.interest,q.insurance,q.fees,q.total].every(v=>MONEY.test(v)))))return 'Completa el calendario hipotético y todos sus componentes. El servidor comprueba su conciliación.';
   }
   if(a.kind==='ASSET_PURCHASE'&&(![a.grossCost,a.ownCash,a.ownDebt].every(v=>typeof v==='string'&&MONEY.test(v))||!a.ownershipFraction||!FRACTION.test(a.ownershipFraction)||!a.vacancyFraction||!FRACTION.test(a.vacancyFraction)||a.estimatedGrossValue!==null&&(typeof a.estimatedGrossValue!=='string'||!MONEY.test(a.estimatedGrossValue))))return 'Completa costo, financiación, participación, vacancia y estimación explícita o no disponible.';
   for(const f of [...a.rentSchedule??[],...a.costSchedule??[]])if(!DATE.test(f.date)||!MONEY.test(f.amount)||!f.sourceReference.trim())return 'Cada renta o costo hipotético necesita fecha, importe y declaración.';
   for(const f of a.reserveReleases??[])if(!f.fundId||!DATE.test(f.date)||f.date<=input.asOf||!MONEY.test(f.amount))return 'La liberación hipotética necesita fondo, fecha e importe.';
  }
  return null;
}

function events(kind: ScenarioKind, row: HypothesisDraft, ids: Record<string, string>, asOf: string): CapitalEventBody[] {
  const result: CapitalEventBody[] = [];
  if (leg(row.capitalOutDate, row.capitalOutAmount, row.sourceReference, asOf) === null && row.capitalOutDate !== '' && ids[`${kind}:out`]) {
    result.push({ id: ids[`${kind}:out`]!, date: row.capitalOutDate, kind: 'DECLARED_CAPITAL_OUT', amount: row.capitalOutAmount, cashSourceFlowId: null, sourceReference: row.sourceReference.trim(), economicClass: 'WITHDRAWAL' });
  }
  if (leg(row.capitalInDate, row.capitalInAmount, row.sourceReference, asOf) === null && row.capitalInDate !== '' && ids[`${kind}:in`]) {
    result.push({ id: ids[`${kind}:in`]!, date: row.capitalInDate, kind: 'DECLARED_CAPITAL_IN', amount: row.capitalInAmount, cashSourceFlowId: null, sourceReference: row.sourceReference.trim(), economicClass: 'CAPITAL_CONTRIBUTION' });
  }
  if(row.reinvestment)result.push({...row.reinvestment,kind:'REINVESTMENT',economicClass:'PRINCIPAL_RECOVERY'});
  return result;
}

export function buildVersion(input: VersionInput & { baseId: string; baseToken: string }): VersionBody | null {
  if (versionProblem(input)) return null;
  const assumptions: AssumptionBody[] = KINDS.map(kind => {
    const row = input.hypotheses[kind];
    return {
      kind,
      collectionFraction: row.collectionFraction,
      delayDays: Number(row.delayDays),
      recoveryFraction: row.recoveryFraction,
      recoveryDelayDays: Number(row.recoveryDelayDays),
      interestProjection: row.interestProjection as AssumptionBody['interestProjection'],
      dateOverrides: row.dateOverrides??[],
      capitalEvents: events(kind, row, input.eventIds, input.asOf),
    };
  });
  const alternatives: AlternativeBody[] = input.alternatives?input.alternatives.map(a=>a.configured?{...a,budget:input.budget,reserveReleases:a.reserveReleases??[],...(a.kind==='NEW_LOAN'?{cashSourceFlowId:a.cashSourceFlowId??null}:{})}:{kind:a.kind,budget:input.budget,configured:false,reason:'NOT_CONFIGURED'}):ALTERNATIVES.map(kind => kind === 'HOLD_CASH'
    ? { kind, budget: input.budget, configured: true, reserveReleases: [] }
    : { kind, budget: input.budget, configured: false, reason: 'NOT_CONFIGURED' });
  return { baseId: input.baseId, baseToken: input.baseToken, horizonDays: Number(input.horizonDays), assumptions, alternatives };
}

export function sameComparison(left: { baseId: string; sourceDigest: string; horizonDays: number }, right: { baseId: string; sourceDigest: string; horizonDays: number }): boolean {
  return left.baseId === right.baseId && left.sourceDigest === right.sourceDigest && left.horizonDays === right.horizonDays;
}
