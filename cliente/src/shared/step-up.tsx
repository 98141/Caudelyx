import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as QRCodeModule from 'qrcode';
import { bindProofRequired, call, creationOptions, credentialJson, currentSessionEpoch, refreshCsrf, requestOptions, type PublicKeyShape } from './api';
import { useAuth } from './auth';
import { ApiError, DiscardedRequest, StepUpCancelled, purposeClass } from './contracts';
import { publishFlash } from './flash';
import { grantActive } from './session-activity';
import { ErrorText, Field, SecretTextField, Submit, onSubmit } from './ui';

interface StepUpRequest {
  purpose: string;
  force?: boolean;
  resourceId?: string;
  command?: unknown;
  summary: string;
}

type Handler = (request: StepUpRequest) => Promise<void>;
let handler: Handler | null = null;

export function ensureStepUp(request: StepUpRequest): Promise<void> {
  if (!purposeClass(request.purpose)) return Promise.resolve();
  if (!handler) return Promise.reject(new ApiError(503, 'SERVICE_UNAVAILABLE', null, 'No se pudo abrir la confirmación.'));
  return handler(request);
}

function bodyOf(request: StepUpRequest, method: 'TOTP' | 'WEBAUTHN'): Record<string, unknown> {
  return {
    purpose: request.purpose,
    method,
    ...(request.resourceId ? { resourceId: request.resourceId } : {}),
    ...(request.command !== undefined ? { command: request.command } : {}),
  };
}

function Qr({ uri }: { uri: string }) {
  const [image, setImage] = useState('');
  useEffect(() => {
    let live = true;
    const toDataURL = (QRCodeModule as unknown as { toDataURL: (text: string, options: { margin: number; width: number; errorCorrectionLevel: 'M' }) => Promise<string> }).toDataURL;
    void toDataURL(uri, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(value => {
      if (live) setImage(value);
    }).catch(() => { if (live) setImage(''); });
    return () => { live = false; setImage(''); };
  }, [uri]);
  if (!image) return <p role="status">Preparando el código QR…</p>;
  return <img src={image} alt="" width={240} height={240} />;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { me, phase, clock, refresh, applySession } = useAuth();
  const [request, setRequest] = useState<StepUpRequest | null>(null);
  const [mode, setMode] = useState<'code' | 'password' | 'qr'>('code');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [intentId, setIntentId] = useState('');
  const [uri, setUri] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');
  const [manual, setManual] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const resolver = useRef<((value: void) => void) | null>(null);
  const rejecter = useRef<((reason: unknown) => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const serial = useRef(0);
  const controller = useRef(new AbortController());
  const owner = useRef('');
  const bindings = useRef<{actor: string; request: StepUpRequest}[]>([]);
  const [expiresAt, setExpiresAt] = useState(0);
  const renderSerial = serial.current;
  const setCurrentError = (value: unknown) => { if (renderSerial === serial.current) setError(value); };
  const setCurrentPending = (value: boolean) => { if (renderSerial === serial.current) setPending(value); };
  function check(ticket: number) { if (ticket !== serial.current || controller.current.signal.aborted) throw new DiscardedRequest(); }
  async function requestCall<T>(...args: Parameters<typeof call<T>>) {
    const ticket = serial.current;
    const result = await call<T>(args[0], args[1], args[2], { ...args[3], signal: controller.current.signal });
    check(ticket); return result;
  }

  function finish(action: 'resolve' | 'cancel', expected = serial.current) {
    if (expected !== serial.current) return;
    serial.current += 1; controller.current.abort();
    const resolve = resolver.current;
    const reject = rejecter.current;
    resolver.current = null;
    rejecter.current = null;
    setRequest(null);
    setMode('code');
    setCode('');
    setPassword('');
    setIntentId('');
    setUri('');
    setEnrollmentId('');
    setManual('');
    setError(null); setExpiresAt(0); setPending(false);
    if (action === 'resolve') resolve?.();
    else reject?.(new StepUpCancelled());
    const target = returnFocus.current;
    requestAnimationFrame(() => { if (target?.isConnected) target.focus(); });
  }

  useEffect(() => {
    handler = async (next) => {
      if (resolver.current) throw new ApiError(409, 'INVALID_STATE', null, 'Termina o cancela la confirmación abierta.');
      const actor = `${me?.userId ?? ''}:${currentSessionEpoch()}`;
      bindings.current = [...bindings.current.filter(item => item.actor === actor).slice(-15), {actor, request: structuredClone(next)}];
      if (!next.force && purposeClass(next.purpose) === 'BALANCE_60M' && grantActive(clock)) return;
      return new Promise<void>((resolve, reject) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        resolver.current = resolve;
        rejecter.current = reject;
        serial.current += 1; controller.current = new AbortController();
        owner.current = `${me?.userId ?? ''}:${currentSessionEpoch()}`;
        setIntentId(''); setEnrollmentId(''); setManual(''); setExpiresAt(0);
        setError(null);
        setCode('');
        setPassword('');
        setUri('');
        setMode('code');
        setRequest(next);
      });
    };
    bindProofRequired((path, body, key) => {
      const actor = `${me?.userId ?? ''}:${currentSessionEpoch()}`;
      const found = [...bindings.current].reverse().find(item => {
        if (item.actor !== actor) return false;
        const saved = item.request, command = saved.command as {idempotencyKey?: string; payload?: unknown} | undefined;
        if (key && command?.idempotencyKey === key) return JSON.stringify(command.payload) === JSON.stringify(body);
        const target = new Map([
          ['PASSWORD_CHANGE','/auth/password/change'],['RECOVERY_CODES_REGENERATE','/auth/mfa/recovery-codes/regenerate'],['SESSION_REVOKE_ALL','/auth/sessions/revoke-all'],
          ['ORGANIZATION_SESSIONS_REVOKE','/organization/sessions/revoke-all'],['MEMBER_SUSPEND',`/organization/members/${saved.resourceId}/suspend`],['MEMBER_REACTIVATE',`/organization/members/${saved.resourceId}/reactivate`],['MEMBER_SESSIONS_REVOKE',`/organization/members/${saved.resourceId}/sessions/revoke`],['SESSION_REVOKE_OTHER',`/auth/sessions/${saved.resourceId}`],['MFA_REMOVE',`/auth/mfa/methods/${saved.resourceId}`],['MEMBER_INVITE','/organization/invitations'],['MEMBER_ROLE_CHANGE',`/organization/members/${saved.resourceId}/roles`],
        ]).get(saved.purpose);
        return target === path && (!saved.command || JSON.stringify(saved.command) === JSON.stringify(body));
      });
      if (found && !resolver.current) void handler?.({...found.request, force:true}).catch(() => undefined);
    });
    return () => { handler = null; bindProofRequired(null); };
  }, [clock, me?.userId]);

  useEffect(() => {
    if (phase !== 'ready') bindings.current = [];
    if (request && (phase !== 'ready' || owner.current !== `${me?.userId ?? ''}:${currentSessionEpoch()}`)) finish('cancel');
  }, [phase, me?.userId, request]);
  useEffect(() => () => { controller.current.abort(); rejecter.current?.(new StepUpCancelled()); resolver.current = null; rejecter.current = null; }, []);

  useEffect(() => {
    if (!request) return;
    const node = dialogRef.current;
    node?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finish('cancel'); return; }
      if (event.key !== 'Tab' || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>('input, button, select, textarea, a[href]')];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, mode]);

  useEffect(() => {
    if (!uri) return;
    const timer = window.setTimeout(() => {
      setUri('');
      setManual('');
      setEnrollmentId('');
      setMode('password'); setCode(''); setError(new ApiError(403, 'INITIAL_MFA_PROOF_DENIED', null, 'Venció el alta. El código QR se retiró. No se aplicó la acción.'));
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [uri, expiresAt]);

  async function prepare(method: 'TOTP' | 'WEBAUTHN'): Promise<string | null> {
    const ticket = serial.current;
    if (!request) return null;
    try {
      const prepared = await requestCall<{ intentId: string; expiresAt: string; method: string; publicKey?: PublicKeyShape }>(
        'POST', '/auth/step-up/intents', bodyOf(request, method),
      );
      setIntentId(prepared.data.intentId);
      if (method === 'WEBAUTHN' && prepared.data.publicKey) {
        const credential = await navigator.credentials.get({ ...requestOptions(prepared.data.publicKey), signal: controller.current.signal });
        check(ticket);
        if (!(credential instanceof PublicKeyCredential)) throw new ApiError(422, 'INPUT_INVALID', null, 'No se obtuvo la passkey.');
        await verifyWebauthn(prepared.data.intentId, credential);
      }
      return prepared.data.intentId;
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'MFA_ENROLLMENT_REQUIRED') {
        setMode('password');
        setError(null);
        return null;
      }
      throw caught;
    }
  }

  useEffect(() => {
    if (!request) return;
    const ticket = serial.current;
    setPending(true);
    void prepare('TOTP').catch(error => { if (ticket === serial.current) setError(error); }).finally(() => { if (ticket === serial.current) setPending(false); });
    // One prepare for each newly opened action; session metadata updates do not prepare again.
  }, [request]);

  async function verifyCode() {
    const ticket = serial.current;
    if (!request) return;
    const id = intentId || await prepare('TOTP');
    if (!id || !/^[0-9]{6}$/.test(code)) return;
    const result = await requestCall<{ verifiedClass: string; session?: SessionMetaLike; proofExpiresAt?: string }>(
      'POST', '/auth/step-up/verify', { intentId: id, method: 'TOTP', code },
    );
    await refreshCsrf(); check(ticket);
    if (result.data.session) applySession(result.data.session);
    await refresh(); check(ticket);
    finish('resolve', ticket);
  }

  async function verifyWebauthn(id: string, credential: PublicKeyCredential) {
    const ticket = serial.current;
    const result = await requestCall<{ verifiedClass: string; session?: SessionMetaLike }>(
      'POST', '/auth/step-up/verify', { intentId: id, method: 'WEBAUTHN', credential: credentialJson(credential) },
    );
    await refreshCsrf(); check(ticket);
    if (result.data.session) applySession(result.data.session);
    await refresh(); check(ticket);
    finish('resolve', ticket);
  }

  async function enroll() {
    if (!request) return;
    const prepared = await requestCall<{ enrollmentId: string; provisioningUri: string; expiresAt: string }>(
      'POST', '/auth/mfa/totp/enrollments',
      { label: 'Factor de esta acción', password, stepUp: bodyOf(request, 'TOTP') },
    );
    setPassword('');
    setEnrollmentId(prepared.data.enrollmentId);
    setUri(prepared.data.provisioningUri);
    const parsed = new URL(prepared.data.provisioningUri);
    setManual(parsed.searchParams.get('secret') ?? '');
    const server = clock ? Date.parse(clock.meta.serverNow) + Date.now() - clock.receivedAt : Date.now();
    setExpiresAt(Date.now() + Math.max(0, Date.parse(prepared.data.expiresAt) - server));
    setMode('qr');
  }

  async function enrollPasskey() {
    const ticket = serial.current;
    if (!request) return;
    const options = await requestCall<{ ceremonyId: string; publicKey: PublicKeyShape }>(
      'POST', '/auth/mfa/webauthn/registration/options',
      { label: 'Factor de esta acción', password, stepUp: bodyOf(request, 'WEBAUTHN') },
    );
    setPassword('');
    const credential = await navigator.credentials.create({ ...creationOptions(options.data.publicKey), signal: controller.current.signal });
    check(ticket);
    if (!(credential instanceof PublicKeyCredential)) throw new ApiError(422, 'INPUT_INVALID', null, 'El autenticador no entregó una credencial.');
    const verified = await requestCall<{ nextAction?: string }>('POST', '/auth/mfa/webauthn/registration/verify', {
      ceremonyId: options.data.ceremonyId, credential: credentialJson(credential),
    });
    await refreshCsrf(); check(ticket);
    await refresh(); check(ticket);
    publishFlash('Factor registrado');
    if (verified.data.nextAction === 'LOGIN') {
      setError(new ApiError(401, 'AUTH_INVALID', null, 'El alta cerró la sesión. Ingresa de nuevo. No se aplicó la acción.'));
      return;
    }
    finish('resolve', ticket);
  }

  async function confirmEnrollment() {
    const ticket = serial.current;
    const result = await requestCall<{ nextAction?: string }>('POST', `/auth/mfa/totp/enrollments/${enrollmentId}/confirm`, { code });
    setUri('');
    setManual('');
    setCode('');
    await refreshCsrf(); check(ticket);
    await refresh(); check(ticket);
    publishFlash('Factor registrado');
    if (result.data.nextAction === 'LOGIN') {
      setError(new ApiError(401, 'AUTH_INVALID', null, 'El alta cerró la sesión. Ingresa de nuevo. No se aplicó la acción.'));
      return;
    }
    finish('resolve', ticket);
  }

  return (
    <>
      <div className="step-up-content" inert={request ? true : undefined}>{children}</div>
      {request ? (
        <div className="modal-backdrop">
          <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <h2 id={titleId}>Confirma con tu código</h2>
            <p>{request.summary}</p>
            <ErrorText error={error} />
            {error instanceof ApiError && ['OFFLINE', 'SERVICE_UNAVAILABLE'].includes(error.code) ? <button type="button" disabled={pending} onClick={() => {
              const ticket = serial.current; setPending(true);
              void refresh().then(live => { check(ticket); if (!live) return; publishFlash('Sesión consultada. No se reenvió el código ni la acción. Vuelve a revisar y confirmar la operación.'); finish('cancel', ticket); }).catch(setCurrentError).finally(() => setCurrentPending(false));
            }}>Revisar sesión</button> : null}
            {mode === 'password' ? (
              <form onSubmit={onSubmit(enroll, setCurrentPending, setCurrentError)}>
                <p>Esta cuenta todavía no tiene factor. Escribe otra vez la contraseña. El código se pide una sola vez.</p>
                <SecretTextField label="Contraseña" value={password} onChange={setPassword} autoComplete="current-password" />
                <Submit pending={pending}>Continuar con aplicación</Submit>
                {typeof PublicKeyCredential !== 'undefined' ? <button type="button" disabled={pending} onClick={() => { setPending(true); void enrollPasskey().catch(setCurrentError).finally(() => setCurrentPending(false)); }}>Continuar con Hello</button> : null}
              </form>
            ) : null}
            {mode === 'qr' ? (
              <form onSubmit={onSubmit(confirmEnrollment, setCurrentPending, setCurrentError)}>
                <div className="qr-frame"><Qr uri={uri} /></div>
                <details>
                  <summary>Clave manual</summary>
                  <p className="manual-key">{manual}</p>
                </details>
                <Field label="Código de 6 dígitos"><input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></Field>
                <Submit pending={pending}>Confirmar y continuar</Submit>
              </form>
            ) : null}
            {mode === 'code' ? (
              <form onSubmit={onSubmit(verifyCode, setCurrentPending, setCurrentError)}>
                <Field label="Código de 6 dígitos"><input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></Field>
                <Submit pending={pending}>Confirmar</Submit>
              </form>
            ) : null}
            {mode === 'code' ? <button type="button" disabled={pending} onClick={() => { setPending(true); void prepare('WEBAUTHN').catch(setCurrentError).finally(() => setCurrentPending(false)); }}>Usar passkey</button> : null}
            <button type="button" onClick={() => finish('cancel')}>Cancelar</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

interface SessionMetaLike {
  serverNow: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  balanceVerifiedUntil: string | null;
}
