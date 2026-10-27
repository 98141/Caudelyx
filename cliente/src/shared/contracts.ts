export const SYNTHETIC_POLICY_VERSION = 'synthetic-v1';
export const API_BASE = '/api/v1';

export const ASSIGNABLE_BY_TITULAR = ['A', 'O', 'C', 'P', 'L'] as const;
export const ASSIGNABLE_BY_ADMIN = ['O', 'C', 'P', 'L'] as const;
export const ROLE_LABEL: Record<string, string> = {
  T: 'Titular',
  A: 'Administrador',
  O: 'Operador',
  C: 'Cobrador',
  P: 'Aprobador',
  L: 'Consultor',
};

export const REASON_OPTIONS = [
  { value: 'SECURITY', label: 'Seguridad' },
  { value: 'STAFF_CHANGE', label: 'Cambio de personal' },
  { value: 'OWNER_REQUEST', label: 'Solicitud del titular' },
] as const;

export const A19_WARNING = 'Si completas este restablecimiento antes de registrar tu primer factor MFA, no podrás terminar el alta y no hay reparación disponible en esta fase. Si no solicitaste el restablecimiento, ignora este correo y no lo completes';

export type AuthState =
  | 'EMAIL_REQUIRED'
  | 'PENDING_EMAIL'
  | 'MFA_REQUIRED'
  | 'MFA_ENROLLMENT'
  | 'FACTOR_LOSS_BLOCKED'
  | 'RECOVERY_RESTRICTED'
  | 'AUTHENTICATED_NO_ORG'
  | 'ACTIVE'
  | 'WORKING'
  | 'WORKING_NO_ORG';

export interface SessionMeta {
  serverNow: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  balanceVerifiedUntil: string | null;
}

export interface ProfileView {
  displayName: string;
  email: string;
  emailVerified: boolean;
  createdAt?: string;
  hasFactor?: boolean;
  version?: string;
}

export interface Me {
  authState: AuthState;
  sessionContext?: 'B' | 'L' | 'S' | 'W';
  nextAction?: string;
  profile?: ProfileView;
  expiresAt?: string;
  userId?: string;
  organizationId?: string;
  roleIds?: string[];
  session?: SessionMeta;
}

export interface ApiSuccess<T> {
  data: T;
  requestId: string | null;
  etag: string | null;
  status: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, requestId: string | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const CODE_TEXT: Record<string, string> = {
  OFFLINE: 'Sin conexión. No se guardó nada. Al volver la red, consulta el estado antes de reintentar.',
  BAD_REQUEST: 'La solicitud no es válida.',
  CSRF_INVALID: 'No se pudo confirmar el origen. Recarga la página e inténtalo de nuevo.',
  AUTH_INVALID: 'No se pudo comprobar la identidad. Revisa los datos e inténtalo de nuevo.',
  TOKEN_INVALID: 'El código no es válido o ya no está disponible.',
  MFA_INVALID: 'El factor no es válido.',
  ACCESS_DENIED: 'No tienes permiso para esta acción. Esto no cierra tu sesión.',
  ACCOUNT_ALREADY_EXISTS: 'Ya existe una cuenta con ese correo. Ingresa o restablece la contraseña.',
  EMAIL_NOT_VERIFIED: 'Confirma tu correo para crear organizaciones. No se consultaron datos de negocio.',
  MFA_REQUIRED: 'La contraseña sola no abre el acceso. Falta verificar un factor.',
  REAUTH_REQUIRED: 'Hay que volver a confirmar el código de esta acción. No se aplicó.',
  RECOVERY_RESTRICTED: 'La cuenta está en recuperación restringida. No hay acceso de negocio.',
  INITIAL_MFA_PROOF_DENIED: 'El alta del primer factor no está disponible en este momento.',
  FACTOR_LOSS_BLOCKED: 'No hay un factor activo para continuar.',
  NOT_FOUND: 'No se encontró el recurso solicitado.',
  INVALID_STATE: 'El estado actual no permite esta acción. Vuelve a preparar el paso.',
  ORGANIZATION_ALREADY_ASSIGNED: 'Esta cuenta ya tiene una organización. No se crea otra.',
  IDEMPOTENCY_CONFLICT: 'La clave de reintento no corresponde a este mismo cuerpo.',
  ETAG_REQUIRED: 'Falta la versión del recurso. No se aplicó el cambio.',
  R_REQUIRED: 'Falta confirmar con tu código. No se aplicó el comando.',
  SESSION_EXPIRED: 'La sesión venció. Ingresa de nuevo.',
  INITIAL_BALANCE_UNAVAILABLE: 'Este libro ya tiene movimientos. Un saldo nuevo se registra con un asiento normal.',
  INITIAL_BALANCE_CONFLICT: 'No se registró el saldo inicial. Hay una apertura en curso o la cuenta de capital no es inequívoca.',
  SOURCE_CONFLICT: 'Esa referencia de origen ya se usó en otro comando. No se contabilizó de nuevo.',
  UNBALANCED_ENTRY: 'El asiento no cuadra. No se contabilizó.',
  CURRENCY_MISMATCH: 'La moneda no es COP. No se contabilizó.',
  ACCOUNT_OVERDRAFT: 'La caja o el banco quedaría en negativo. No se contabilizó.',
  ALREADY_REVERSED: 'Ese asiento ya tiene una compensación. No se creó otra.',
  RESOURCE_NOT_FOUND: 'No se encontró ese recurso en esta organización.',
  MFA_ENROLLMENT_REQUIRED: 'Falta completar el factor antes de cambiar el rol. El rol no cambió.',
  ONBOARDING_REQUIRED: 'Falta completar el alta.',
  PRECONDITION_FAILED: 'Los datos cambiaron; actualiza antes de guardar.',
  PRECONDITION_REQUIRED: 'Falta la versión del recurso. Actualiza antes de guardar. No se aplicó el cambio.',
  INPUT_INVALID: 'Hay datos que no cumplen el formato exigido.',
  INPUT_TOO_LARGE: 'La solicitud supera el tamaño admitido. No se recortó ni se aplicó.',
  ROUTE_NOT_FOUND: 'Esa ruta no existe. No se aplicó ninguna operación.',
  METHOD_NOT_ALLOWED: 'Ese método no está permitido en la ruta. No se aplicó ninguna operación.',
  BOOK_NOT_ELIGIBLE: 'El libro ya tiene movimientos. No admite esta apertura.',
  OPENING_ALREADY_POSTED: 'Este libro ya tiene una apertura confirmada. No se creó otra.',
  OPENING_STATE_CONFLICT: 'El estado del expediente no permite esta acción. No hubo efecto.',
  OPENING_VALIDATION_STALE: 'La validación quedó desactualizada. No hubo efecto. Si el expediente ya estaba aprobado, guarda de nuevo con un motivo para invalidar esa aprobación. Luego valida y aprueba otra vez; la huella no se cambia a mano.',
  OPENING_NOT_BALANCED: 'El expediente no está conciliado. No se aprobó ni se confirmó.',
  OPENING_CUTOFF_CONFLICT: 'La fecha choca con el corte de apertura. No se aplicó.',
  OPENING_IMMUTABLE: 'La apertura confirmada no se edita ni se revierte desde aquí.',
  BORROWER_CODE_CONFLICT: 'Ese código ya existe en esta organización. No se creó otra ficha.',
  BORROWER_DOCUMENT_CONFLICT: 'Ese documento ya está en otra ficha de esta organización. No se duplicó.',
  OPENING_REFERENCE_CONFLICT: 'Esa referencia de apertura ya está vinculada. No se creó otra ficha.',
  SCHEMA_EVOLUTION_CONFLICT: 'La ficha usa un catálogo anterior. Recarga los campos y vuelve a guardar.',
  QUOTE_EXPIRED: 'La simulación venció. Vuelve a pedir el cronograma. No se guardó.',
  QUOTE_STALE: 'La simulación ya no corresponde a los datos actuales. Vuelve a pedir el cronograma. No se guardó.',
  QUOTE_ALREADY_USED: 'Esa simulación ya se usó en otros términos. Pide un cronograma nuevo. No se duplicó.',
  QUOTE_BINDING_MISMATCH: 'La simulación no corresponde a estos términos. Vuelve a pedir el cronograma. No se guardó.',
  POLICY_UNSUPPORTED: 'Esas condiciones no están en la política vigente. No se calculó.',
  UNSUPPORTED_CALENDAR: 'El calendario pedido no está admitido. No se calculó.',
  IRREGULAR_PERIOD_UNSUPPORTED: 'Esa combinación de fechas no está admitida. No se calculó.',
  PAYMENT_RESOLUTION_UNSUPPORTED: 'La cuota no se pudo resolver con esta política. No se calculó.',
  CALCULATION_UNREPRESENTABLE: 'El resultado no cabe en el formato admitido. No se ajustó a ojo.',
  INVALID_DATE: 'La fecha no es válida.',
  INVALID_CURSOR: 'La página pedida no es válida. Vuelve al inicio del listado.',
  STATE_CONFLICT: 'El estado actual no permite esta acción. No hubo efecto.',
  REAL_USE_NOT_ALLOWED: 'Esta política no autoriza un préstamo real. No se aplicó.',
  POLICY_CHANGED: 'La política cambió. Pide otro plan. No se aplicó el anterior.',
  TERMS_STALE: 'Los términos ya no coinciden con la ficha o la cuenta. Hay que confirmarlos de nuevo. No se desembolsó.',
  PREVIEW_EXPIRED: 'El plan venció. Pide otro con la misma clave. No se creó un segundo comando.',
  PREVIEW_STALE: 'El plan ya no corresponde a estos datos. Pide otro. No se aplicó.',
  ALREADY_DISBURSED: 'Ese préstamo ya tiene desembolso. No se hizo otro.',
  ACCOUNT_PROFILE_CONFLICT: 'Las cuentas del libro no coinciden con las elegidas. No se cambió el perfil.',
  DOMAIN_ACCOUNT_PROTECTED: 'Esa cuenta está ligada a préstamos. No se hizo un asiento manual.',
  DOMAIN_REVERSAL_FORBIDDEN: 'Ese asiento de préstamo no se revierte desde el libro manual.',
  NO_ACCRUAL_DUE: 'No hay interés vencido nuevo para reconocer. No se devengó el futuro.',
  CREDIT_INSUFFICIENT: 'El saldo a favor no alcanza. No se aplicó.',
  EXCESS_NOT_ALLOWED: 'Ese objetivo ya no admite el excedente del modo original. El pendiente sigue igual. No se declaró una devolución.',
  RECEIPT_REFERENCE_CONFLICT: 'Esa referencia de cobro ya se usó. No se cobró otra vez.',
  LATER_JOURNAL_CONFLICT: 'Hay un asiento posterior en el libro. No se aplicó esta fecha.',
  ACCOUNT_INELIGIBLE: 'La cuenta no está activa o no corresponde a caja, banco o la clase pedida. No se usó.',
  UNSUPPORTED_PAYMENT_VARIANT: 'Esa forma de abono no está admitida. No se aplicó ni se acortó el plazo a mano.',
  MONEY_OVERFLOW: 'El importe no cabe en el formato admitido. No se ajustó.',
  INTEGRITY_MISMATCH: 'Los términos guardados no coinciden con su historia. No se desembolsó ni se corrigió solo.',
  RATE_LIMITED: 'Hay demasiados intentos. Espera antes de volver a intentarlo.',
  SERVICE_UNAVAILABLE: 'El dominio no está disponible. Puede estar cerrado por una migración. No se confirmó nada y esta pantalla no lo reabre.',
  PAYMENT_STATE_CONFLICT: 'Ese objetivo ya no admite la acción. El pendiente sigue igual. No se declaró una devolución ni se abrió otro expediente.',
  SEGREGATION_REQUIRED: 'Este registro supervisado necesita otro titular o aprobador. No se confirmó.',
  PAYMENT_FLOW_REQUIRED: 'Ese cobro directo ya no está disponible. Regístralo en Pagos. No se cobró.',
  REVERSAL_DEPENDENCY: 'Hay un hecho posterior que impide este reverso. No se compensó.',
  REVERSAL_SNAPSHOT_UNAVAILABLE: 'No hay una foto verificable del hecho original. No se revirtió.',
  FUNDS_NOT_HELD: 'No hay fondos retenidos suficientes. No se compensó.',
  BANK_DECLARATION_DUPLICATE: 'Esa línea declarada ya existe. No se creó otra.',
  LINK_CONFLICT: 'Ese pago o esa declaración ya tiene un vínculo. No se enlazó otra vez.',
  RECONCILIATION_MISMATCH: 'El importe, la cuenta, la fecha o la referencia no coinciden. No se concilió.',
  UNSUPPORTED_REVERSAL_KIND: 'Ese tipo de hecho no se revierte desde aquí.',
  DATE_NOT_ALLOWED: 'La fecha contable no es la de hoy en Bogotá. No se aplicó.',
  DELIVERY_FUNDS_COMMITTED: 'Ese efectivo ya está comprometido. No se reservó otra vez.',
  DELIVERY_COUNT_MISMATCH: 'El conteo no coincide con el importe de la entrega. No se confirmó.',
  DELIVERY_COUNTERPARTY_REQUIRED: 'Falta la otra persona del traslado. No se completó.',
  CASH_CLOSE_PENDING: 'Hay pendientes de caja. La jornada no se cerró como exacta y el efectivo no se liberó.',
};

export function messageFor(code: string, status: number): string {
  return CODE_TEXT[code] ?? `No se pudo completar la operación (${status}).`;
}

export function accountCreateError(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 409 && (error.code === 'INPUT_INVALID' || error.code === 'SOURCE_CONFLICT')) {
    return new ApiError(409, error.code, error.requestId, 'No se pudo crear: el código ya existe o entró en conflicto. Revisa el código y vuelve a intentarlo.');
  }
  return error;
}

export class DiscardedRequest extends Error {
  constructor() {
    super('discarded');
    this.name = 'DiscardedRequest';
  }
}

export class StepUpCancelled extends Error {
  constructor() {
    super('Cancelaste la confirmación. No se aplicó.');
    this.name = 'StepUpCancelled';
  }
}

const BALANCE_PURPOSES = new Set([
  'FINANCE_JOURNAL_POST', 'FINANCE_TRANSFER', 'FINANCE_JOURNAL_REVERSE', 'OPENING_COMMIT',
  'LOAN_DISBURSE', 'LOAN_ACCRUE', 'LOAN_RECEIPT_POST', 'LOAN_CREDIT_APPLY',
  'PAYMENT_REGISTER_DIRECT', 'PAYMENT_APPROVE_CONFIRM', 'PAYMENT_REVERSAL_EXECUTE',
  'CASH_DELIVERY_CONFIRM', 'CASH_DELIVERY_COMPENSATION_CONFIRM',
]);
const SECURITY_PURPOSES = new Set([
  'MEMBER_INVITE', 'MEMBER_ROLE_CHANGE', 'MEMBER_SUSPEND', 'MEMBER_REACTIVATE', 'MEMBER_SESSIONS_REVOKE',
  'ORGANIZATION_SESSIONS_REVOKE', 'PASSWORD_CHANGE', 'MFA_ENROLL', 'MFA_REMOVE', 'RECOVERY_CODES_REGENERATE',
  'SESSION_REVOKE_OTHER', 'SESSION_REVOKE_ALL',
  'CUSTODY_BINDING_SET', 'PAYMENT_REGISTRATION_SCOPE_SET', 'CASH_STATION_SET',
]);

export function purposeClass(purpose: string): 'BALANCE_60M' | 'SECURITY_ONE_SHOT' | null {
  if (BALANCE_PURPOSES.has(purpose)) return 'BALANCE_60M';
  if (SECURITY_PURPOSES.has(purpose)) return 'SECURITY_ONE_SHOT';
  return null;
}

export function isStrong(me: Me | null): boolean {
  return me?.authState === 'ACTIVE' || me?.authState === 'AUTHENTICATED_NO_ORG'
    || me?.authState === 'WORKING' || me?.authState === 'WORKING_NO_ORG';
}

export function inOrganization(me: Me | null): boolean {
  return Boolean(me?.organizationId) && (me?.authState === 'ACTIVE' || me?.authState === 'WORKING');
}

export function stableIdempotencyKey(scope: { current: { body: string; key: string } }, body: unknown): string {
  const serialized = JSON.stringify(body);
  if (scope.current.body !== serialized || scope.current.key.length < 16) {
    scope.current = { body: serialized, key: crypto.randomUUID() };
  }
  return scope.current.key;
}
