import { useEffect, useId, useRef, useState } from 'react';
import { toString as qrSvg } from 'qrcode';
import { call, creationOptions, credentialJson, reauthenticate, requestOptions } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError } from '../../shared/contracts';
import { Alert, Empty, ErrorText, Field, Panel, SecretOnce, StepFields, Submit, onSubmit } from '../../shared/ui';

interface Factor { id: string; type: 'TOTP' | 'WEBAUTHN'; label: string; createdAt: string; lastUsedAt: string | null; version: string }
interface SessionItem { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; deviceLabel: string; current: boolean }

type PasskeyOffer = 'platform' | 'external' | 'unavailable';

export function usePasskeyOffer(): PasskeyOffer {
  const [offer, setOffer] = useState<PasskeyOffer>(() => {
    if (typeof window === 'undefined' || !window.isSecureContext || typeof PublicKeyCredential === 'undefined') return 'unavailable';
    return 'external';
  });
  useEffect(() => {
    if (offer === 'unavailable' || typeof PublicKeyCredential === 'undefined') return;
    const probe = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
    if (!probe) return;
    let live = true;
    void probe.call(PublicKeyCredential).then(yes => { if (live && yes) setOffer('platform'); }).catch(() => undefined);
    return () => { live = false; };
  }, [offer]);
  return offer;
}

function mapPasskey(error: unknown): unknown {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return new ApiError(0, 'PASSKEY_CANCELLED', null, 'Se canceló la passkey. Puedes reintentar o usar la app autenticadora.');
  }
  if (error instanceof DOMException && (error.name === 'NotSupportedError' || error.name === 'SecurityError')) {
    return new ApiError(0, 'PASSKEY_UNSUPPORTED', null, 'Este navegador no puede crear la passkey. Usa la app autenticadora.');
  }
  return error;
}

function totpParts(uri: string): { secret: string; account: string; issuer: string } | null {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'otpauth:') return null;
    const secret = url.searchParams.get('secret');
    if (!secret || !/^[A-Za-z2-7]+=*$/.test(secret)) return null;
    const issuer = url.searchParams.get('issuer') ?? '';
    const path = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const account = path.includes(':') ? path.split(':').slice(1).join(':') : path;
    return { secret, account, issuer };
  } catch {
    return null;
  }
}

function TotpQr({ uri }: { uri: string }) {
  const [image, setImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setImage(null);
    setFailed(false);
    void qrSvg(uri, { type: 'svg', margin: 2, width: 240, errorCorrectionLevel: 'M', color: { dark: '#0f172a', light: '#ffffff' } })
      .then(svg => { if (live) setImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; setImage(null); };
  }, [uri]);
  if (!image && !failed) return <p role="status">Preparando el código QR en este navegador…</p>;
  return (
    <div className="qr-frame">
      {image ? <img src={image} alt="Código QR de la misma cuenta. La clave manual está en el apartado plegable." /> : null}
      {failed ? <p role="status">No se pudo dibujar el QR en este navegador. Usa la clave manual.</p> : null}
    </div>
  );
}

export function TotpMaterial({ uri, onClear }: { uri: string; onClear: () => void }) {
  const clear = useRef(onClear);
  useEffect(() => { clear.current = onClear; }, [onClear]);
  useEffect(() => {
    const timeout = window.setTimeout(() => clear.current(), 5 * 60 * 1000);
    return () => window.clearTimeout(timeout);
  }, [uri]);
  const parts = totpParts(uri);
  return (
    <div className="secret">
      <TotpQr uri={uri} />
      {parts ? (
        <details open>
          <summary>Clave manual</summary>
          <p className="manual-key">{parts.secret}</p>
          <p className="muted">{parts.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
          <p>Cuenta: {parts.account || 'la de esta alta'}</p>
          <p>Emisor: {parts.issuer || 'Caudelyx'}</p>
          <p>En la app autenticadora elige entrada manual. Escribe la clave, la cuenta y el emisor. El QR y esta clave salen de la misma dirección.</p>
        </details>
      ) : <p>La semilla no tiene el formato esperado. No la copies a otra página.</p>}
      <SecretOnce label="URI TOTP de un solo uso" value={uri} onClear={onClear} />
    </div>
  );
}

function MethodSelect({ value, onChange, offer }: { value: 'TOTP' | 'WEBAUTHN'; onChange: (value: 'TOTP' | 'WEBAUTHN') => void; offer: PasskeyOffer }) {
  const hint = offer === 'unavailable'
    ? 'Este navegador no puede crear una passkey. Usa la app autenticadora.'
    : offer === 'platform'
      ? 'Si el equipo ofrece Windows Hello, el navegador puede usarla. Esta pantalla no afirma que esté probada.'
      : 'La passkey usa una llave externa u otro autenticador de este navegador.';
  return (
    <Field label="Tipo" hint={hint}>
      <select value={value} onChange={event => onChange(event.target.value as 'TOTP' | 'WEBAUTHN')}>
        <option value="TOTP">TOTP</option>
        {offer === 'platform' ? <option value="WEBAUTHN">Passkey de este dispositivo</option> : null}
        {offer === 'external' ? <option value="WEBAUTHN">Passkey con llave externa</option> : null}
      </select>
    </Field>
  );
}

type SecuritySection = 'resumen' | 'metodos' | 'contrasena' | 'recuperacion' | 'sesiones';

function securitySection(): SecuritySection {
  const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('seccion');
  if (value === 'metodos' || value === 'contrasena' || value === 'recuperacion' || value === 'sesiones') return value;
  return 'resumen';
}

function useSecuritySection(): SecuritySection {
  const [section, setSection] = useState<SecuritySection>(securitySection);
  useEffect(() => {
    const sync = () => setSection(securitySection());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return section;
}

function EntryIcon({ path }: { path: string }) {
  return (
    <span className="account-entry-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false"><path d={path} /></svg>
    </span>
  );
}

function SecurityEntry({ href, title, text, path }: { href: string; title: string; text: string; path: string }) {
  const descriptionId = useId();
  return (
    <a className="account-entry" href={href} aria-label={title} aria-describedby={descriptionId}>
      <EntryIcon path={path} />
      <span className="account-entry-copy">
        <span className="account-entry-title">{title}</span>
        <span className="account-entry-text" id={descriptionId}>{text}</span>
      </span>
      <svg className="account-entry-go" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg>
    </a>
  );
}

export function SecurityGateLink({ text }: { text: string }) {
  return (
    <ul className="account-entries">
      <li><SecurityEntry href="#/seguridad" title="Ir a Seguridad" text={text} path="M12 3l7 3v6c0 5-3.2 7.6-7 9-3.8-1.4-7-4-7-9V6l7-3z" /></li>
    </ul>
  );
}

export function SecurityMenu({ strong }: { strong: boolean }) {
  return (
    <ul className="account-entries">
      <li><SecurityEntry href="#/seguridad?seccion=metodos" title="Métodos de autenticación" text="Registra o retira un factor de esta cuenta." path="M12 3l7 3v6c0 5-3.2 7.6-7 9-3.8-1.4-7-4-7-9V6l7-3z" /></li>
      {strong ? <li><SecurityEntry href="#/seguridad?seccion=contrasena" title="Contraseña" text="Cambia la contraseña de acceso." path="M8 11V8a4 4 0 1 1 8 0v3M6 11h12v9H6z" /></li> : null}
      {strong ? <li><SecurityEntry href="#/seguridad?seccion=recuperacion" title="Códigos de recuperación" text="Genera códigos nuevos de un solo uso." path="M4 8h16M4 12h16M4 16h10" /></li> : null}
      {strong ? <li><SecurityEntry href="#/seguridad?seccion=sesiones" title="Sesiones activas" text="Revisa y cierra sesiones operativas." path="M4 5h16v10H4zM8 19h8M12 15v4" /></li> : null}
    </ul>
  );
}

function SecurityBack() {
  return (
    <p className="security-back">
      <a href="#/seguridad">Volver a Seguridad</a>
      <a href="#/perfil">Volver a Mi cuenta</a>
    </p>
  );
}

export function FirstFactorSetup() {
  const { refresh, me } = useAuth();
  const basic = me?.sessionContext === 'B';
  const offer = usePasskeyOffer();
  const [label, setLabel] = useState('Factor sintético');
  const [factorPassword, setFactorPassword] = useState('');
  const [methodType, setMethodType] = useState<'TOTP' | 'WEBAUTHN'>('TOTP');
  const [uri, setUri] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => () => { setUri(''); setCode(''); setFactorPassword(''); }, []);
  useEffect(() => { if (!me) { setUri(''); setFactorPassword(''); } }, [me]);

  async function enroll() {
    if (methodType === 'WEBAUTHN' && offer === 'unavailable') {
      throw new ApiError(0, 'PASSKEY_UNSUPPORTED', null, 'Este navegador no puede crear la passkey. Usa la app autenticadora.');
    }
    try {
      const enrollmentBody = basic ? { label, password: factorPassword } : { label };
      if (methodType === 'TOTP') {
        const result = await call<{ enrollmentId: string; provisioningUri: string }>('POST', '/auth/mfa/totp/enrollments', enrollmentBody);
        setFactorPassword('');
        setEnrollmentId(result.data.enrollmentId);
        setUri(result.data.provisioningUri);
        setInfo('La clave se muestra una sola vez. No se guarda en este navegador.');
      } else {
        const options = await call<{ ceremonyId: string; publicKey: Parameters<typeof creationOptions>[0] }>('POST', '/auth/mfa/webauthn/registration/options', enrollmentBody);
        setFactorPassword('');
        const credential = await navigator.credentials.create(creationOptions(options.data.publicKey));
        if (!(credential instanceof PublicKeyCredential)) throw new ApiError(422, 'INPUT_INVALID', null, 'El autenticador no entregó una credencial.');
        const verified = await call<{ nextAction?: string }>('POST', '/auth/mfa/webauthn/registration/verify', { ceremonyId: options.data.ceremonyId, credential: credentialJson(credential) });
        setUri('');
        setInfo(verified.data.nextAction === 'LOGIN' ? 'El factor adicional cerró las sesiones. Vuelve a ingresar.' : 'Factor registrado. La contraseña sola sigue sin abrir el negocio.');
        await refresh();
      }
    } catch (error) {
      throw mapPasskey(error);
    }
  }

  async function confirmTotp() {
    await call('POST', `/auth/mfa/totp/enrollments/${enrollmentId}/confirm`, { code });
    setUri(''); setCode(''); setEnrollmentId('');
    setInfo('Factor registrado. La contraseña sola sigue sin abrir el negocio.');
    await refresh();
  }

  return (
    <section className="security-sheet">
      <h2>Proteger mi cuenta</h2>
      <p>Elige un método para proteger la cuenta. No se puede omitir.</p>
      <ErrorText error={error} />
      {error instanceof ApiError && error.code === 'MFA_REQUIRED' ? <p>Siguiente paso: pide un enlace nuevo desde el perfil. Sin ese enlace el servidor no deja proteger la cuenta.</p> : null}
      {info ? <Alert tone="pending">{info}</Alert> : null}
      {uri ? <TotpMaterial uri={uri} onClear={() => { setUri(''); setEnrollmentId(''); setCode(''); }} /> : null}
      <form onSubmit={onSubmit(enroll, setPending, setError)}>
        <Field label="Etiqueta"><input value={label} onChange={event => setLabel(event.target.value)} maxLength={60} required /></Field>
        {basic ? <Field label="Contraseña actual" hint="Hay que escribirla de nuevo para registrar el primer factor. No se guarda en el navegador."><input value={factorPassword} onChange={event => setFactorPassword(event.target.value)} type="password" autoComplete="current-password" minLength={15} maxLength={128} required /></Field> : null}
        <MethodSelect value={methodType} onChange={setMethodType} offer={offer} />
        <Submit pending={pending}>Preparar factor</Submit>
      </form>
      {enrollmentId ? (
        <form onSubmit={onSubmit(confirmTotp, setPending, setError)}>
          <Field label="Código TOTP actual"><input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></Field>
          <Submit pending={pending}>Confirmar TOTP</Submit>
        </form>
      ) : null}
    </section>
  );
}

export function SecurityScreen() {
  const { me, phase, refresh } = useAuth();
  const [label, setLabel] = useState('Factor sintético');
  const [methodType, setMethodType] = useState<'TOTP' | 'WEBAUTHN'>('TOTP');
  const [uri, setUri] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');
  const [newMethodId, setNewMethodId] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [stepCode, setStepCode] = useState('');
  const [factors, setFactors] = useState<Factor[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [retire, setRetire] = useState<string[]>([]);
  const [codes, setCodes] = useState<string[]>([]);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  const restricted = me?.authState === 'RECOVERY_RESTRICTED';
  const enrollment = me?.authState === 'MFA_ENROLLMENT';
  const strong = me?.authState === 'ACTIVE' || me?.authState === 'AUTHENTICATED_NO_ORG';
  const offer = usePasskeyOffer();
  const section = useSecuritySection();

  useEffect(() => () => { setUri(''); setCodes([]); setPassword(''); setCode(''); setStepCode(''); setCurrentPassword(''); setNewPassword(''); }, []);
  useEffect(() => {
    if (!strong && !restricted) return;
    void call<{ items: Factor[] }>('GET', '/auth/mfa/methods').then(result => setFactors(result.data.items)).catch(setError);
    if (strong) void call<{ items: SessionItem[] }>('GET', '/auth/sessions').then(result => setSessions(result.data.items)).catch(() => undefined);
  }, [strong, restricted, info]);

  async function enroll() {
    try {
      if (methodType === 'WEBAUTHN' && offer === 'unavailable') {
        throw new ApiError(0, 'PASSKEY_UNSUPPORTED', null, 'Este navegador no puede crear la passkey. Usa la app autenticadora.');
      }
      if (strong) await reauthenticate({ password, purpose: 'MFA_ENROLL', command: { methodType, label }, code: stepCode });
      if (methodType === 'TOTP') {
        const result = await call<{ enrollmentId: string; provisioningUri: string }>('POST', '/auth/mfa/totp/enrollments', { label });
        setEnrollmentId(result.data.enrollmentId);
        setUri(result.data.provisioningUri);
        setInfo('La clave se muestra una sola vez. No se guarda en este navegador.');
      } else {
        const options = await call<{ ceremonyId: string; publicKey: Parameters<typeof creationOptions>[0] }>('POST', '/auth/mfa/webauthn/registration/options', { label });
        const credential = await navigator.credentials.create(creationOptions(options.data.publicKey));
        if (!(credential instanceof PublicKeyCredential)) throw new ApiError(422, 'INPUT_INVALID', null, 'El autenticador no entregó una credencial.');
        const verified = await call<{ methodId: string; nextAction?: string }>('POST', '/auth/mfa/webauthn/registration/verify', { ceremonyId: options.data.ceremonyId, credential: credentialJson(credential) });
        await finish(verified.data.nextAction, verified.data.methodId);
      }
      setPassword(''); setStepCode('');
    } catch (error) {
      setPassword(''); setStepCode('');
      throw mapPasskey(error);
    }
  }

  async function confirmTotp() {
    const result = await call<{ methodId: string; nextAction?: string }>('POST', `/auth/mfa/totp/enrollments/${enrollmentId}/confirm`, { code });
    setUri(''); setCode(''); setEnrollmentId('');
    await finish(result.data.nextAction, result.data.methodId);
  }

  async function finish(nextAction: string | undefined, methodId: string) {
    if (restricted) {
      setNewMethodId(methodId);
      setInfo('El factor nuevo queda pendiente. Elige los factores activos que se retirarán y confírmalo. El pendiente no sirve para ingresar.');
      return;
    }
    if (nextAction === 'LOGIN') {
      setInfo('El factor adicional cerró las sesiones. Vuelve a ingresar.');
      await refresh();
      return;
    }
    setInfo('Factor registrado. La contraseña sola sigue sin abrir el negocio.');
    await refresh();
  }

  async function passkeyLogin() {
    const options = await call<{ ceremonyId: string; publicKey: Parameters<typeof requestOptions>[0] }>('POST', '/auth/mfa/webauthn/authentication/options', { purpose: 'LOGIN' });
    const credential = await navigator.credentials.get(requestOptions(options.data.publicKey));
    if (!(credential instanceof PublicKeyCredential)) throw new ApiError(422, 'INPUT_INVALID', null, 'No se obtuvo la passkey.');
    await call('POST', '/auth/mfa/challenges/verify', { method: 'WEBAUTHN', purpose: 'LOGIN', ceremonyId: options.data.ceremonyId, credential: credentialJson(credential) });
    setInfo('Factor comprobado.');
    await refresh();
  }

  if (me?.authState === 'EMAIL_REQUIRED' || me?.authState === 'PENDING_EMAIL') return (
    <Panel title="Seguridad" id="page-title">
      <div className="account-center">
        <p>Confirma tu correo antes de proteger la cuenta. Aquí no se registra un factor antes de eso.</p>
        <p><a href="#/perfil">Volver al perfil</a></p>
      </div>
    </Panel>
  );

  if (me?.nextAction === 'ENROLL_FIRST_FACTOR') return (
    <Panel title="Seguridad" id="page-title">
      <div className="account-center">
        <FirstFactorSetup />
      </div>
    </Panel>
  );

  if (enrollment && !restricted) return (
    <Panel title="Seguridad" id="page-title">
      <div className="account-center security-sheet">
        <h2>Proteger mi cuenta</h2>
        <p>Este ingreso no trae el alta del factor. Pide un enlace nuevo y ábrelo en este mismo navegador.</p>
        <ErrorText error={error} />
        {info ? <Alert tone="pending">{info}</Alert> : null}
        <button type="button" disabled={pending} onClick={() => {
          setError(null); setPending(true);
          void call('POST', '/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' })
            .then(() => setInfo('Solicitud recibida. Abre el enlace del canal local en este mismo ingreso. Esto no abre la organización.'))
            .catch(setError).finally(() => setPending(false));
        }}>Pedir enlace de protección</button>
      </div>
    </Panel>
  );

  return (
    <Panel title="Seguridad de la cuenta" id="page-title">
      <div className="account-center">
        {strong ? <p><a href="#/organizacion">Continuar a la organización</a></p> : null}
        {phase === 'anonymous' ? <Alert tone="info">Ingresa o verifica el correo para administrar factores. No hay sesión que mostrar.</Alert> : null}
        {restricted ? <Alert tone="pending">Recuperación restringida{me?.expiresAt ? ` hasta ${new Date(me.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}` : ''}. No hay acceso de negocio y el estado no se muestra a administradores.</Alert> : null}
        <ErrorText error={error} />
        {info ? <Alert tone="pending">{info}</Alert> : null}
        {uri ? <TotpMaterial uri={uri} onClear={() => { setUri(''); setEnrollmentId(''); setCode(''); }} /> : null}
        {codes.length ? <SecretOnce label="Códigos de recuperación, una sola visualización" value={codes.join(' ')} onClear={() => setCodes([])} /> : null}
        {section === 'resumen' ? (
          <>
            <p className="profile-lead">Elige una operación. El formulario correspondiente se abre solo.</p>
            <SecurityMenu strong={strong} />
          </>
        ) : (
          <div className="security-sheet">
            <SecurityBack />
            {section === 'metodos' ? (
              <>
                <form onSubmit={onSubmit(enroll, setPending, setError)}>
                  <h2>{enrollment || restricted ? 'Registrar factor de esta fase' : 'Añadir factor'}</h2>
                  <Field label="Etiqueta"><input value={label} onChange={event => setLabel(event.target.value)} maxLength={60} required /></Field>
                  <MethodSelect value={methodType} onChange={setMethodType} offer={offer} />
                  {strong ? <StepFields legend="Confirmar alta del factor" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} /> : null}
                  <Submit pending={pending}>Preparar factor</Submit>
                </form>
                {enrollmentId ? (
                  <form onSubmit={onSubmit(confirmTotp, setPending, setError)}>
                    <Field label="Código TOTP actual"><input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></Field>
                    <Submit pending={pending}>Confirmar TOTP</Submit>
                  </form>
                ) : null}
                {me?.authState === 'MFA_REQUIRED' ? <button type="button" onClick={() => void passkeyLogin().catch(setError)}>Comprobar passkey</button> : null}
                <section>
                  <h2>Factores activos</h2>
                  {factors.length === 0 ? <Empty>No hay factores activos en esta consulta.</Empty> : (
                    <div className="security-list">
                      {factors.map(factor => (
                        <article className="security-item" key={factor.id}>
                          <h3>{factor.label}</h3>
                          <p>{factor.type} · creado {new Date(factor.createdAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
                          {strong ? <button type="button" onClick={() => void remove(factor).catch(setError)}>Retirar factor</button> : null}
                        </article>
                      ))}
                    </div>
                  )}
                </section>
                {restricted ? (
                  <form onSubmit={onSubmit(async () => {
                    if (!newMethodId) throw new ApiError(409, 'INVALID_STATE', null, 'Primero confirma el factor nuevo. No se usa un factor activo como reemplazo.');
                    const result = await call<{ recoveryCodes: string[] }>('POST', '/auth/mfa/recovery/complete', { newMethodId, retireMethodIds: retire });
                    setCodes(result.data.recoveryCodes);
                    setRetire([]); setNewMethodId('');
                    setInfo('Recuperación cerrada y sesiones revocadas. Vuelve a ingresar.');
                    await refresh();
                  }, setPending, setError)}>
                    <h2>Cerrar recuperación</h2>
                    <p>Factor nuevo pendiente: {newMethodId || 'aún no confirmado'}.</p>
                    <div className="checks">
                      {factors.map(factor => (
                        <label key={factor.id}><input type="checkbox" checked={retire.includes(factor.id)} onChange={event => setRetire(event.target.checked ? [...retire, factor.id] : retire.filter(id => id !== factor.id))} /> Retirar {factor.label}</label>
                      ))}
                    </div>
                    <Submit pending={pending}>Confirmar factor nuevo y retiros</Submit>
                  </form>
                ) : null}
              </>
            ) : null}
            {section === 'recuperacion' && strong ? (
              <form onSubmit={onSubmit(async () => {
                await reauthenticate({ password, purpose: 'RECOVERY_CODES_REGENERATE', code: stepCode });
                const result = await call<{ codes: string[] }>('POST', '/auth/mfa/recovery-codes/regenerate');
                setCodes(result.data.codes);
                setPassword(''); setStepCode('');
                setInfo('Códigos nuevos. Los anteriores dejaron de servir. Guárdalos fuera de este navegador.');
              }, setPending, setError)}>
                <h2>Regenerar códigos de recuperación</h2>
                <p className="muted">Los códigos nuevos sustituyen a los anteriores y se muestran una sola vez.</p>
                <StepFields legend="Confirmar códigos nuevos" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
                <Submit pending={pending}>Regenerar</Submit>
              </form>
            ) : null}
            {section === 'recuperacion' && !strong ? <p>Esta sesión no regenera códigos de recuperación. El reemplazo de factores, cuando aplica, está en Métodos de autenticación.</p> : null}
            {section === 'contrasena' && strong ? (
              <form onSubmit={onSubmit(async () => {
                await reauthenticate({ password, purpose: 'PASSWORD_CHANGE', code: stepCode });
                await call('POST', '/auth/password/change', { currentPassword, newPassword });
                setCurrentPassword(''); setNewPassword(''); setPassword(''); setStepCode('');
                setInfo('Contraseña cambiada. Las sesiones se cerraron.');
                await refresh();
              }, setPending, setError)}>
                <h2>Cambiar contraseña</h2>
                <StepFields legend="Confirmar cambio de contraseña" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
                <Field label="Contraseña actual del cambio"><input value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" required /></Field>
                <Field label="Contraseña nueva"><input value={newPassword} onChange={event => setNewPassword(event.target.value)} type="password" autoComplete="new-password" minLength={15} maxLength={128} required /></Field>
                <Submit pending={pending}>Cambiar contraseña</Submit>
              </form>
            ) : null}
            {section === 'contrasena' && !strong ? <p>Esta sesión no cambia la contraseña.</p> : null}
            {section === 'sesiones' && strong ? (
              <section>
                <h2>Sesiones</h2>
                {sessions.length === 0 ? <Empty>No hay sesiones operativas para mostrar.</Empty> : (
                  <div className="security-list">
                    {sessions.map(session => (
                      <article className={session.current ? 'security-item is-current' : 'security-item'} key={session.id}>
                        <h3>{session.deviceLabel}{session.current ? ' · esta sesión' : ''}</h3>
                        <p>Visto {new Date(session.lastSeenAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
                        <button type="button" onClick={() => void revoke(session).catch(setError)}>Cerrar esta sesión</button>
                      </article>
                    ))}
                  </div>
                )}
                <form onSubmit={onSubmit(async () => {
                  await reauthenticate({ password, purpose: 'SESSION_REVOKE_ALL', code: stepCode });
                  await call('POST', '/auth/sessions/revoke-all');
                  setInfo('Se cerraron las sesiones operativas.');
                  await refresh();
                }, setPending, setError)}>
                  <StepFields legend="Confirmar cierre de sesiones" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
                  <Submit pending={pending}>Cerrar todas las sesiones</Submit>
                </form>
              </section>
            ) : null}
            {section === 'sesiones' && !strong ? <p>Esta sesión no lista sesiones operativas.</p> : null}
          </div>
        )}
      </div>
    </Panel>
  );

  async function remove(factor: Factor) {
    await reauthenticate({ password, purpose: 'MFA_REMOVE', resourceId: factor.id, code: stepCode });
    await call('DELETE', `/auth/mfa/methods/${factor.id}`, undefined, { ifMatch: factor.version });
    setInfo('Factor retirado.');
    setFactors(factors.filter(item => item.id !== factor.id));
  }
  async function revoke(session: SessionItem) {
    if (!session.current) await reauthenticate({ password, purpose: 'SESSION_REVOKE_OTHER', resourceId: session.id, code: stepCode });
    await call('DELETE', `/auth/sessions/${session.id}`);
    setInfo(session.current ? 'Esta sesión se cerró.' : 'La otra sesión se cerró.');
    if (session.current) await refresh();
    else setSessions(sessions.filter(item => item.id !== session.id));
  }
}
