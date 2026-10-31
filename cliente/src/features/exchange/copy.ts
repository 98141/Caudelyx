import type { Cell } from './types';

export const MODE_LABEL: Record<string, string> = {
  OPENING: 'Apertura',
  OPERATIVE: 'Operación',
  HISTORICAL_LINK: 'Enlace histórico',
  INFORMATIONAL: 'Informativo',
};

export const STATE_LABEL: Record<string, string> = {
  CREATED: 'Creado',
  UPLOADED: 'Archivo recibido',
  PREVIEWING: 'Vista previa en curso',
  READY: 'Listo para confirmar',
  INVALID: 'Con observaciones',
  COMMITTED: 'Confirmado',
  CANCELLED: 'Cancelado',
  EXPIRED: 'Vencido',
  QUEUED: 'En cola',
  RUNNING: 'En proceso',
  SUCCEEDED: 'Archivo listo',
  FAILED: 'No se completó',
};

export const REPORT_LABEL: Record<string, string> = {
  PORTFOLIO: 'Cartera',
  PORTFOLIO_OVERDUE: 'Cartera vencida',
  AGEING: 'Antigüedad',
  PAR30: 'PAR30',
  INSTALLMENTS: 'Cuotas',
  MOVEMENTS: 'Movimientos',
  INTEREST: 'Interés',
  PRINCIPAL: 'Principal',
  CASH: 'Caja',
  RECONCILIATION: 'Conciliación',
  COLLECTORS: 'Cobradores',
  CONCENTRATION: 'Concentración',
  OBLIGATIONS: 'Obligaciones',
  EXPENSES: 'Gastos',
  SAVINGS: 'Ahorro',
  ASSETS: 'Activos',
  FUNDING_USES: 'Fuentes y usos',
  NET_WORTH: 'Patrimonio',
  NET_WORTH_EVOLUTION: 'Evolución del patrimonio',
  PERSONAL_SUMMARY: 'Resumen personal',
  CONSOLIDATED_SUMMARY: 'Resumen consolidado',
};

export const SCOPE_LABEL: Record<string, string> = {
  BUSINESS: 'Organización',
  PERSONAL: 'Personal',
  CONSOLIDATED: 'Consolidado privado',
  ASSIGNED_AND_OWN: 'Cartera asignada y actividad propia',
  OWN_ACTIVITY: 'Actividad propia',
  AUTHORIZED_PAYMENTS: 'Pagos autorizados',
};

export const COVERAGE_LABEL: Record<string, string> = {
  COMPLETE: 'Cobertura completa',
  INCOMPLETE: 'Cobertura incompleta',
  UNAVAILABLE: 'No disponible',
  NO_DENOMINATOR: 'Sin denominador',
  NOT_APPLICABLE: 'NA',
};

export const ISSUE_LABEL: Record<string, string> = {
  TYPE_INVALID: 'El tipo de la celda no es válido.',
  REQUIRED: 'Falta un dato obligatorio.',
  UNKNOWN_COLUMN: 'Hay una columna que la plantilla no admite.',
  UNKNOWN_SHEET: 'Hay una hoja que la plantilla no admite.',
  INVALID_DATE: 'La fecha no es válida.',
  INVALID_MONEY: 'El importe no es válido.',
  DUPLICATE_KEY: 'La clave está repetida.',
  REFERENCE_INVALID: 'La referencia no se resuelve.',
  SOURCE_CONFLICT: 'La referencia ya existe en otra operación.',
  VERSION_STALE: 'La versión del recurso cambió.',
  BALANCE_DIFFERENCE: 'La apertura no cuadra.',
  SCHEDULE_DIFFERENCE: 'El calendario no cuadra con el importe.',
  INTEREST_MISMATCH: 'El interés no coincide con el origen.',
  BOOK_NOT_ELIGIBLE: 'El libro no admite esta apertura.',
  MODE_UNSUPPORTED: 'Ese modo no admite esta hoja.',
  AP10_A3_DEFERRED: 'Esa operación de activos sigue diferida. Este archivo no la habilita.',
  ACTIVE_CONTENT: 'El archivo trae contenido activo. No se ejecutó.',
  LIMIT_EXCEEDED: 'El archivo supera un límite del contrato.',
  DECLARED_NOT_VERIFIED: 'El dato queda declarado. No pasa a verificado.',
};

export const SEVERITY_LABEL: Record<string, string> = {
  ERROR: 'Error',
  WARNING: 'Advertencia',
  DEFERRED: 'Diferido',
};

export const SHEETS = [
  'Control', 'Prestatarios', 'Prestamos', 'Cuotas', 'Cuentas', 'Obligaciones', 'Activos',
  'Fuentes', 'Antecedentes', 'Soportes', 'Apertura', 'Intereses', 'Operaciones',
];

const COLUMN_GROUP: Record<string, string> = {
  principal: 'Principal',
  overduePrincipal: 'Principal',
  principalPaid: 'Principal',
  interest: 'Interés',
  interestPaid: 'Interés',
  recognized: 'Interés',
  overdueInterest: 'Interés',
  book: 'Caja',
  available: 'Caja',
  reserved: 'Reservas',
  provisional: 'Caja',
  confirmed: 'Caja',
  committed: 'Caja',
  cashFlow: 'Caja',
  estimated: 'Estimación',
  estimatedGross: 'Estimación',
  estimatedOwn: 'Estimación',
  grossCostDeclared: 'Costo declarado',
  recognizedCost: 'Costo',
  indicativeEquity: 'Patrimonio indicativo',
  excludedParticipation: 'Porción excluida',
  ownDebt: 'Deuda propia',
};

export function columnGroup(columnId: string): string {
  return COLUMN_GROUP[columnId] ?? 'Dato del servidor';
}

export function showCell(cell: Cell): string {
  if (cell.status === 'NOT_APPLICABLE') return 'NA';
  if (cell.value === null || cell.value === undefined || cell.status === 'UNAVAILABLE' || cell.status === 'NO_DENOMINATOR') return 'No disponible';
  return String(cell.value);
}

export function knownLabel(map: Record<string, string>, key: string, fallback: string): string {
  return Object.hasOwn(map, key) ? map[key] : fallback;
}

export function safeFileLabel(name: string): string {
  if (!name || name.length > 120 || /[<>"'`\\/]/.test(name) || name !== name.trim()) return 'Archivo seleccionado';
  return name;
}
