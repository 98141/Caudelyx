import { API_BASE, ApiError, DiscardedRequest, messageFor, type ApiSuccess } from './contracts';

let csrfToken: string | null = null;
let sessionEpoch = 0;
let onSessionLost: ((code: string) => void) | null = null;
let onProofRequired: ((path: string, body: unknown, key?: string) => void) | null = null;
export function bindProofRequired(handler: typeof onProofRequired) { onProofRequired = handler; }

export function currentSessionEpoch(): number {
  return sessionEpoch;
}

export function bumpSessionEpoch(): number {
  sessionEpoch += 1;
  return sessionEpoch;
}

export function bindSessionLost(handler: ((code: string) => void) | null): void {
  onSessionLost = handler;
}

function sessionProbe(path: string): boolean {
  return path === '/auth/me' || path === '/auth/csrf' || path === '/auth/login' || path === '/auth/register'
    || path.startsWith('/auth/password-reset') || path.startsWith('/auth/email-verifications')
    || path.startsWith('/auth/registrations') || path === '/auth/logout' || path.startsWith('/auth/mfa/');
}

export function resetSessionMemory(): void {
  csrfToken = null;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64urlToBytes(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface PublicKeyShape {
  challenge: string;
  rp?: PublicKeyCredentialRpEntity;
  user?: { id: string; name: string; displayName: string };
  pubKeyCredParams?: PublicKeyCredentialParameters[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  excludeCredentials?: { type: PublicKeyCredentialType; id: string; transports?: string[] }[];
  allowCredentials?: { type: PublicKeyCredentialType; id: string; transports?: string[] }[];
  timeout?: number;
  rpId?: string;
  userVerification?: UserVerificationRequirement;
}

function descriptor(item: { type: PublicKeyCredentialType; id: string; transports?: string[] }): PublicKeyCredentialDescriptor {
  return {
    type: item.type,
    id: base64urlToBytes(item.id) as BufferSource,
    transports: item.transports as AuthenticatorTransport[] | undefined,
  };
}

export function creationOptions(publicKey: PublicKeyShape): CredentialCreationOptions {
  return {
    publicKey: {
      challenge: base64urlToBytes(publicKey.challenge) as BufferSource,
      rp: publicKey.rp ?? { name: 'Caudelyx' },
      user: {
        id: base64urlToBytes(publicKey.user?.id ?? '') as BufferSource,
        name: publicKey.user?.name ?? 'usuario',
        displayName: publicKey.user?.displayName ?? 'Usuario',
      },
      pubKeyCredParams: publicKey.pubKeyCredParams ?? [],
      authenticatorSelection: publicKey.authenticatorSelection,
      attestation: publicKey.attestation,
      excludeCredentials: (publicKey.excludeCredentials ?? []).map(descriptor),
      timeout: publicKey.timeout,
    },
  };
}

export function requestOptions(publicKey: PublicKeyShape): CredentialRequestOptions {
  return {
    publicKey: {
      challenge: base64urlToBytes(publicKey.challenge) as BufferSource,
      rpId: publicKey.rpId,
      allowCredentials: (publicKey.allowCredentials ?? []).map(descriptor),
      userVerification: publicKey.userVerification,
      timeout: publicKey.timeout,
    },
  };
}

export function credentialJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response;
  const shared = {
    id: bytesToBase64url(new Uint8Array(credential.rawId)),
    rawId: bytesToBase64url(new Uint8Array(credential.rawId)),
    type: 'public-key' as const,
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
  };
  if (response instanceof AuthenticatorAttestationResponse) {
    return {
      ...shared,
      response: {
        clientDataJSON: bytesToBase64url(new Uint8Array(response.clientDataJSON)),
        attestationObject: bytesToBase64url(new Uint8Array(response.attestationObject)),
      },
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...shared,
    response: {
      clientDataJSON: bytesToBase64url(new Uint8Array(assertion.clientDataJSON)),
      authenticatorData: bytesToBase64url(new Uint8Array(assertion.authenticatorData)),
      signature: bytesToBase64url(new Uint8Array(assertion.signature)),
      userHandle: assertion.userHandle ? bytesToBase64url(new Uint8Array(assertion.userHandle)) : null,
    },
  };
}

async function readBody(response: Response): Promise<{ data: unknown; requestId: string | null; etag: string | null }> {
  if (response.status === 204) return { data: null, requestId: null, etag: response.headers.get('ETag') };
  let payload: { data?: unknown; error?: { code?: string; message?: string }; requestId?: string };
  try { payload = await response.json(); } catch { throw new ApiError(503, 'SERVICE_UNAVAILABLE', null, 'La respuesta no permitió confirmar el resultado. Revisa la sesión antes de reintentar.'); }
  if (!response.ok) {
    const code = payload.error?.code ?? 'SERVICE_UNAVAILABLE';
    throw new ApiError(response.status, code, payload.requestId ?? null, messageFor(code, response.status));
  }
  return { data: payload.data, requestId: payload.requestId ?? null, etag: response.headers.get('ETag') };
}

export async function call<T>(method: string, path: string, body?: unknown, extra?: { ifMatch?: string; idempotencyKey?: string; signal?: AbortSignal }, retry = true): Promise<ApiSuccess<T>> {
  if (extra?.signal?.aborted) throw new DiscardedRequest();
  const epoch = sessionEpoch;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError(0, 'OFFLINE', null, messageFor('OFFLINE', 0));
  }
  const headers = new Headers({ Accept: 'application/json' });
  if (method !== 'GET' && method !== 'HEAD') {
    if (!csrfToken) await refreshCsrf();
    if (epoch !== sessionEpoch || extra?.signal?.aborted) throw new DiscardedRequest();
    headers.set('X-CSRF-Token', csrfToken ?? '');
  }
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (extra?.ifMatch) headers.set('If-Match', extra.ifMatch);
  if (extra?.idempotencyKey) headers.set('Idempotency-Key', extra.idempotencyKey);
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      cache: 'no-store',
      signal: extra?.signal,
    });
  } catch (error) {
    if (extra?.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw new DiscardedRequest();
    throw new ApiError(0, 'OFFLINE', null, messageFor('OFFLINE', 0));
  }
  if (epoch !== sessionEpoch || extra?.signal?.aborted) throw new DiscardedRequest();
  try {
    const parsed = await readBody(response);
    if (epoch !== sessionEpoch || extra?.signal?.aborted) throw new DiscardedRequest();
    return { data: parsed.data as T, requestId: parsed.requestId, etag: parsed.etag, status: response.status };
  } catch (error) {
    if (epoch !== sessionEpoch || extra?.signal?.aborted) throw new DiscardedRequest();
    if (retry && error instanceof ApiError && error.code === 'CSRF_INVALID') {
      csrfToken = null;
      return call(method, path, body, extra, false);
    }
    if (error instanceof ApiError && error.status === 403 && ['R_REQUIRED', 'REAUTH_REQUIRED'].includes(error.code)) onProofRequired?.(path, body, extra?.idempotencyKey);
    if (error instanceof ApiError && error.status === 401 && (error.code === 'AUTH_INVALID' || error.code === 'SESSION_EXPIRED') && !sessionProbe(path)) {
      onSessionLost?.(error.code);
    }
    throw error;
  }
}

export async function refreshCsrf(): Promise<void> {
  const result = await call<{ csrfToken: string }>('GET', '/auth/csrf');
  csrfToken = result.data.csrfToken;
}

export async function verifyPasskey<T>(purpose: string, resourceId?: string): Promise<ApiSuccess<T>> {
  const target = { purpose, ...(resourceId ? { resourceId } : {}) };
  const options = await call<{ ceremonyId: string; publicKey: PublicKeyShape }>('POST', '/auth/mfa/webauthn/authentication/options', target);
  const credential = await navigator.credentials.get(requestOptions(options.data.publicKey));
  if (!(credential instanceof PublicKeyCredential)) throw new ApiError(422, 'INPUT_INVALID', null, 'No se obtuvo la passkey.');
  return call<T>('POST', '/auth/mfa/challenges/verify', {
    ...target, method: 'WEBAUTHN', ceremonyId: options.data.ceremonyId, credential: credentialJson(credential),
  });
}

export async function reauthenticate(input: { password: string; purpose: string; resourceId?: string; command?: unknown; code: string }): Promise<void> {
  const proof: Record<string, unknown> = { password: input.password, purpose: input.purpose };
  if (input.resourceId) proof.resourceId = input.resourceId;
  if (input.command !== undefined) proof.command = input.command;
  await call('POST', '/auth/reauthenticate', proof);
  if (input.code.trim()) {
    const verify: Record<string, unknown> = { method: 'TOTP', purpose: input.purpose, code: input.code };
    if (input.resourceId) verify.resourceId = input.resourceId;
    await call('POST', '/auth/mfa/challenges/verify', verify);
  } else {
    await verifyPasskey(input.purpose, input.resourceId);
  }
  await refreshCsrf();
}
