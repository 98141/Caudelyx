import { ApiError, DiscardedRequest, StepUpCancelled } from '../../shared/contracts';

interface Held {
  key: string;
  signature: string;
  uncertain: boolean;
}

let held: Held | null = null;
let generation = 0;

export function exchangeGeneration(): number {
  return generation;
}

export function clearExchangeMemory(): void {
  held = null;
  generation += 1;
}

export function heldSignature(): string | null {
  return held?.signature ?? null;
}

export function heldUncertain(): boolean {
  return held?.uncertain === true;
}

export function claimKey(signature: string): string {
  if (held?.uncertain && held.signature !== signature) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', null, 'Hay un envío sin resultado confirmado. Consulta su estado antes de cambiar los datos.');
  }
  if (held && held.signature === signature) return held.key;
  const key = crypto.randomUUID();
  held = { key, signature, uncertain: false };
  return key;
}

export function markUncertain(): void {
  if (held) held.uncertain = true;
}

export function releaseHeld(): void {
  held = null;
}

export function isUncertain(error: unknown): boolean {
  if (error instanceof DiscardedRequest || error instanceof StepUpCancelled) return false;
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 503 || error.code === 'OFFLINE' || error.code === 'SERVICE_UNAVAILABLE' || error.code === 'FILE_BUDGET_EXCEEDED';
}
