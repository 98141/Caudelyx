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
  | 'MFA_REQUIRED'
  | 'MFA_ENROLLMENT'
  | 'FACTOR_LOSS_BLOCKED'
  | 'RECOVERY_RESTRICTED'
  | 'AUTHENTICATED_NO_ORG'
  | 'ACTIVE';

export interface ProfileView {
  displayName: string;
  email: string;
  emailVerified: boolean;
}

export interface Me {
  authState: AuthState;
  nextAction?: string;
  profile?: ProfileView;
  expiresAt?: string;
  userId?: string;
  organizationId?: string;
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
  MFA_REQUIRED: 'La contraseña sola no abre el acceso. Falta verificar un factor.',
  REAUTH_REQUIRED: 'Hay que volver a confirmar contraseña y factor con los mismos datos.',
  RECOVERY_RESTRICTED: 'La cuenta está en recuperación restringida. No hay acceso de negocio.',
  INITIAL_MFA_PROOF_DENIED: 'El alta del primer factor no está disponible en este momento.',
  FACTOR_LOSS_BLOCKED: 'No hay un factor activo para continuar.',
  NOT_FOUND: 'No se encontró el recurso solicitado.',
  INVALID_STATE: 'El estado actual no permite esta acción. Vuelve a preparar el paso.',
  ORGANIZATION_ALREADY_ASSIGNED: 'Esta cuenta ya tiene una organización. No se crea otra.',
  IDEMPOTENCY_CONFLICT: 'La clave de reintento no corresponde a este mismo cuerpo.',
  ETAG_REQUIRED: 'Falta la versión del recurso. No se aplicó el cambio.',
  R_REQUIRED: 'Falta confirmar contraseña y factor para este comando. No se aplicó.',
  SOURCE_CONFLICT: 'Esa referencia de origen ya se usó en otro comando. No se contabilizó de nuevo.',
  UNBALANCED_ENTRY: 'El asiento no cuadra. No se contabilizó.',
  CURRENCY_MISMATCH: 'La moneda no es COP. No se contabilizó.',
  ACCOUNT_OVERDRAFT: 'La caja o el banco quedaría en negativo. No se contabilizó.',
  ALREADY_REVERSED: 'Ese asiento ya tiene una compensación. No se creó otra.',
  RESOURCE_NOT_FOUND: 'No se encontró ese recurso en esta organización.',
  MFA_ENROLLMENT_REQUIRED: 'Falta completar el factor antes de cambiar el rol. El rol no cambió.',
  ONBOARDING_REQUIRED: 'Falta completar el alta.',
  PRECONDITION_FAILED: 'La versión cambió (412). Recarga los datos y confirma de nuevo.',
  PRECONDITION_REQUIRED: 'Falta enviar la versión opaca If-Match (428). No se aplicó el cambio.',
  INPUT_INVALID: 'Hay datos que no cumplen el formato exigido.',
  RATE_LIMITED: 'Hay demasiados intentos. Espera antes de volver a intentarlo.',
  SERVICE_UNAVAILABLE: 'El servicio no está disponible. No se confirmó la operación.',
};

export function messageFor(code: string, status: number): string {
  return CODE_TEXT[code] ?? `No se pudo completar la operación (${status}).`;
}

export function isStrong(me: Me | null): boolean {
  return me?.authState === 'ACTIVE' || me?.authState === 'AUTHENTICATED_NO_ORG';
}

export function stableIdempotencyKey(scope: { current: { body: string; key: string } }, body: unknown): string {
  const serialized = JSON.stringify(body);
  if (scope.current.body !== serialized || scope.current.key.length < 16) {
    scope.current = { body: serialized, key: crypto.randomUUID() };
  }
  return scope.current.key;
}
