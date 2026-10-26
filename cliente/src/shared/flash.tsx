import { useSyncExternalStore } from 'react';

let message: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(listener => listener());
}

export function publishFlash(text: string): void {
  message = text;
  emit();
}

export function clearFlash(): void {
  if (!message) return;
  message = null;
  emit();
}

export function useFlash(): string | null {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => message,
    () => null,
  );
}

export function FlashBanner() {
  const text = useFlash();
  if (!text) return null;
  return (
    <div className="alert alert-ok" role="status">
      <p>{text}</p>
      <button type="button" onClick={clearFlash}>Ocultar aviso</button>
    </div>
  );
}
