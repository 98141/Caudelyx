import { call } from './api';

export async function accountLabel(base: string, id: string): Promise<string> {
  try {
    const result = await call<{ code?: unknown; name?: unknown }>('GET', `${base}/accounts/${id}`);
    if (typeof result.data.code === 'string' && typeof result.data.name === 'string' && result.data.code && result.data.name) {
      return `${result.data.code} · ${result.data.name}`;
    }
  } catch {
    return 'Cuenta no disponible';
  }
  return 'Cuenta no disponible';
}

export function borrowerLabel(code: string, name: string): string {
  return `${code} · ${name}`;
}
