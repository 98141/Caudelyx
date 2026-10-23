export type ActivationPurpose = 'ACTIVATION' | 'INITIAL_MFA_PROOF' | 'REJECT';

export type ActivationCapture =
  | { status: 'ready'; purpose: ActivationPurpose; token: string; legacyHint: boolean }
  | { status: 'invalid' };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PURPOSES = new Set<ActivationPurpose>(['ACTIVATION', 'INITIAL_MFA_PROOF']);

let current: ActivationCapture | null = null;

function cleanHash(route = '#/activar'): string {
  const search = window.location.search;
  return `${window.location.pathname}${search}${route}`;
}

function stripFragment(route = '#/activar'): void {
  const next = cleanHash(route);
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    window.history.replaceState(null, '', next);
  }
}

function queryLeaked(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('token') && !params.has('purpose') && !params.has('legacy')) return false;
  params.delete('token');
  params.delete('purpose');
  params.delete('legacy');
  const search = params.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
  return true;
}

function parseFragment(raw: string): ActivationCapture {
  const params = new URLSearchParams(raw);
  const names = [...params.keys()];
  if (new Set(names).size !== names.length) return { status: 'invalid' };
  if (names.some(name => name !== 'purpose' && name !== 'token' && name !== 'legacy')) return { status: 'invalid' };
  const purpose = params.get('purpose');
  const token = params.get('token');
  const legacy = params.get('legacy');
  if (!purpose || !PURPOSES.has(purpose as ActivationPurpose) || !token || !TOKEN.test(token)) return { status: 'invalid' };
  if (legacy !== null && legacy !== '1') return { status: 'invalid' };
  return { status: 'ready', purpose: purpose as ActivationPurpose, token, legacyHint: legacy === '1' };
}

function captureReject(hash: string, leaked: boolean): boolean {
  const queryAt = hash.indexOf('?');
  const route = queryAt < 0 ? hash : hash.slice(0, queryAt);
  if (route !== '#/rechazar') return false;
  if (leaked || queryAt < 0) {
    current = leaked ? { status: 'invalid' } : current;
    if (leaked) stripFragment('#/rechazar');
    return true;
  }
  const params = new URLSearchParams(hash.slice(queryAt + 1));
  const names = [...params.keys()];
  const token = params.get('token');
  const purpose = params.get('purpose');
  if (new Set(names).size !== names.length || names.some(name => name !== 'purpose' && name !== 'token') || purpose !== 'REJECT' || !token || !TOKEN.test(token)) {
    current = { status: 'invalid' };
  } else {
    current = { status: 'ready', purpose: 'REJECT', token, legacyHint: false };
  }
  stripFragment('#/rechazar');
  return true;
}

export function captureActivationLink(): void {
  if (typeof window === 'undefined') return;
  const leaked = queryLeaked();
  const hash = window.location.hash;
  if (captureReject(hash, leaked)) return;
  const queryAt = hash.indexOf('?');
  const route = queryAt < 0 ? hash : hash.slice(0, queryAt);
  if (route !== '#/activar') {
    const params = new URLSearchParams(queryAt < 0 ? '' : hash.slice(queryAt + 1));
    if (['token', 'purpose', 'legacy'].some(name => params.has(name))) {
      for (const name of ['token', 'purpose', 'legacy']) params.delete(name);
      const remaining = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${route}${remaining ? `?${remaining}` : ''}`);
      current = null;
    }
    if (leaked) current = { status: 'invalid' };
    return;
  }
  if (leaked) {
    current = { status: 'invalid' };
    stripFragment();
    return;
  }
  if (queryAt < 0) return;
  current = parseFragment(hash.slice(queryAt + 1));
  stripFragment();
}

export function peekActivation(): ActivationCapture | null {
  return current;
}

export function clearActivationLink(): void {
  current = null;
}

if (typeof window !== 'undefined') window.addEventListener('hashchange', captureActivationLink);
captureActivationLink();
