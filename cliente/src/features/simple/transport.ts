import { call,callDocument } from '../../shared/api';
import { ApiError, DiscardedRequest } from '../../shared/contracts';
import type { CommandSlot } from './memory';
import { markUncertain, releaseSlot } from './memory';
import { concealMessage } from './model';

export const MS_ROOT = '/api/modo-simple/v1';

export interface Cut {
  month: string;
  effectiveDate: string;
  knownAt: string;
}

export function cutQuery(cut: Cut, cursor?: string | null): string {
  const params = new URLSearchParams({ month: cut.month, effectiveDate: cut.effectiveDate });
  if(cut.knownAt)params.set('knownAt',cut.knownAt);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function bookUrl(bookId: string, suffix: string, query?: string): string {
  return `${MS_ROOT}/books/${bookId}/${suffix}${query ? `?${query}` : ''}`;
}

export function concealed(error: unknown): unknown {
  if (error instanceof DiscardedRequest) return error;
  if (error instanceof ApiError) {
    const uniform = concealMessage(error.status);
    if (uniform) return new ApiError(error.status, error.code, error.requestId, uniform);
  }
  return error;
}

export async function msGet<T>(path: string, signal?: AbortSignal): Promise<{ data: T; etag: string | null }> {
  const result = await callDocument<T>('GET', path, undefined, { signal });
  return { data: result.data, etag: result.etag };
}

export async function postKnown<T>(slot: CommandSlot, key: string, path: string, body: unknown, ifMatch: string | undefined, signal: AbortSignal | undefined, outcome: 'keep' | 'finish'): Promise<{ data: T; etag: string | null }> {
  try {
    const result = await callDocument<T>('POST', path, body, { idempotencyKey: key, ifMatch, signal });
    if (outcome === 'finish') releaseSlot(slot);
    return { data: result.data, etag: result.etag };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 0 || error.status === 503 || error.code === 'OFFLINE')) {
      markUncertain(slot);
      throw new ApiError(error.status, error.code, error.requestId, 'No sabemos si se registró. Reintenta el mismo envío cuando vuelva la respuesta. No se crea otra clave.');
    }
    if (error instanceof ApiError && error.code === 'IDEMPOTENCY_CONFLICT') markUncertain(slot);
    else if (error instanceof ApiError && error.status !== 401) releaseSlot(slot);
    throw error;
  }
}

export async function postNativeKnown<T>(slot:CommandSlot,key:string,path:string,body:unknown,ifMatch:string|undefined,outcome:'keep'|'finish'){
 try{const r=await call<T>('POST',path,body,{idempotencyKey:key,ifMatch});if(outcome==='finish')releaseSlot(slot);return r;}catch(e){if(e instanceof ApiError&&(e.status===0||e.status===503||e.code==='OFFLINE')){markUncertain(slot);throw new ApiError(e.status,e.code,e.requestId,'No sabemos si se registró. Reintenta los mismos datos con la misma clave.');}if(e instanceof ApiError&&e.code==='IDEMPOTENCY_CONFLICT')markUncertain(slot);throw e;}
}
