import { ApiError } from '../../shared/contracts';

let held: { signature: string; key: string; uncertain: boolean } | null = null;

export function claimKey(signature: string): string {
  if (held?.signature === signature) return held.key;
  if (held?.uncertain) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', null, 'Hay una solicitud sin resultado confirmado. No se envió otra.');
  const key = crypto.randomUUID();
  held = { signature, key, uncertain: false };
  return key;
}

export function markUncertain(): void {
  if (held) held.uncertain = true;
}

export function releaseHeld(): void {
  held = null;
}

export function clearSimulationMemory(): void {
  held = null;
}

export function isUncertain(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 0 || error.status === 503 || error.code === 'OFFLINE' || error.code === 'SERVICE_UNAVAILABLE';
}
