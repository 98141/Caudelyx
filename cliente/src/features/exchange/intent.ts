import { call } from '../../shared/api';
import { DiscardedRequest } from '../../shared/contracts';

export interface ViewFence { active: boolean }
export function viewCall(fence: ViewFence): typeof call {
 return async <T>(...args: Parameters<typeof call>) => {
  if (!fence.active) throw new DiscardedRequest();
  const result = await call<T>(...args);
  if (!fence.active) throw new DiscardedRequest();
  return result;
 };
}
export async function bytesHash(bytes: Uint8Array): Promise<string> {
 const copy = new Uint8Array(bytes).buffer;
 const digest = await crypto.subtle.digest('SHA-256', copy);
 return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
