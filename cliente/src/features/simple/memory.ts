import { ApiError } from '../../shared/contracts';

export interface CommandSlot {
  key: string | null;
  signature: string | null;
  uncertain: boolean;
}

const slots: CommandSlot[] = [];
const listeners = new Set<() => void>();
let generation = 0;

export function simpleGeneration(): number {
  return generation;
}

export function subscribeSimple(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function createSlot(): CommandSlot {
  const slot: CommandSlot = { key: null, signature: null, uncertain: false };
  slots.push(slot);
  return slot;
}

export function resetSlots(): void {
  for (const slot of slots) {
    slot.key = null;
    slot.signature = null;
    slot.uncertain = false;
  }
}

export function hasUncertain(): boolean {
  return slots.some(slot => slot.uncertain);
}

export function clearSimpleMemory(): void {
  generation += 1;
  resetSlots();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('caudelyx.ms-p03.')) sessionStorage.removeItem(key);
    }
  } catch { /* The session store can be unavailable. The in-memory slots are already empty. */ }
  listeners.forEach(listener => listener());
}

export function keyFor(slot: CommandSlot, signature: string): string {
  if (slot.uncertain && slot.signature !== signature) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', null, 'Hay un envío sin resultado confirmado. Reintenta esos mismos datos. No se crea otra clave.');
  }
  if (!slot.key || slot.signature !== signature) {
    slot.signature = signature;
    slot.key = crypto.randomUUID();
  }
  return slot.key;
}

export function markUncertain(slot: CommandSlot): void {
  slot.uncertain = true;
}

export function releaseSlot(slot: CommandSlot): void {
  slot.key = null;
  slot.signature = null;
  slot.uncertain = false;
}
