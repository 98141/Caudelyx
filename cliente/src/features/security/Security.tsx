import { useEffect, useState } from 'react';
import { call, creationOptions, credentialJson, reauthenticate, requestOptions } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError } from '../../shared/contracts';
import { Alert, Empty, ErrorText, Field, Panel, SecretOnce, StepFields, Submit, onSubmit } from '../../shared/ui';

interface Factor { id: string; type: 'TOTP' | 'WEBAUTHN'; label: string; createdAt: string; lastUsedAt: string | null; version: string }
interface SessionItem { id: string; createdAt: string; lastSeenAt: string; expiresAt: string; deviceLabel: string; current: boolean }

function clearable(value: string, setValue: (next: string) => void) {
  return () => setValue(value ? '' : value);
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

  useEffect(() => () => { setUri(''); setCodes([]); setPassword(''); setCode(''); setStepCode(''); setCurrentPassword(''); setNewPassword(''); }, []);
  useEffect(() => {
    if (!strong && !restricted && !enrollment) return;
    void call<{ items: Factor[] }>('GET', '/auth/mfa/methods').then(result => setFactors(result.data.items)).catch(setError);
    if (strong) void call<{ items: SessionItem[] }>('GET', '/auth/sessions').then(result => setSessions(result.data.items)).catch(() => undefined);
  }, [strong, restricted, enrollment, info]);

  async function enroll() {
    if (strong) await reauthenticate({ password, purpose: 'MFA_ENROLL', command: { methodType, label }, code: stepCode });
    if (methodType === 'TOTP') {
      const result = await call<{ enrollmentId: string; provisioningUri: string }>('POST', '/auth/mfa/totp/enrollments', { label });
      setEnrollmentId(result.data.enrollmentId);
      setUri(result.data.provisioningUri);
      setInfo('La semilla se muestra una sola vez. No se guarda en este navegador.');
    } else {
      const options = await call<{ ceremonyId: string; publicKey: Parameters<typeof creationOptions>[0] }>('POST', '/auth/mfa/webauthn/registration/options', { label });
      const credential = await navigator.credentials.create(creationOptions(options.data.publicKey));
      if (!(credential instanceof PublicKeyCredential)) throw new ApiError(422, 'INPUT_INVALID', null, 'El autenticador no entregó una credencial.');
      const verified = await call<{ methodId: string; nextAction?: string }>('POST', '/auth/mfa/webauthn/registration/verify', { ceremonyId: options.data.ceremonyId, credential: credentialJson(credential) });
      await finish(verified.data.nextAction, verified.data.methodId);
    }
    setPassword(''); setStepCode('');
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

  return (
    <Panel title="Seguridad" id="page-title">
      {phase === 'anonymous' ? <Alert tone="info">Ingresa o verifica el correo para administrar factores. No hay sesión que mostrar.</Alert> : null}
      {restricted ? <Alert tone="pending">Recuperación restringida{me?.expiresAt ? ` hasta ${new Date(me.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}` : ''}. No hay acceso de negocio y el estado no se muestra a administradores.</Alert> : null}
      <ErrorText error={error} />
      {info ? <Alert tone="pending">{info}</Alert> : null}
      {uri ? <SecretOnce label="URI TOTP de un solo uso" value={uri} onClear={clearable(uri, setUri)} /> : null}
      {codes.length ? <SecretOnce label="Códigos de recuperación, una sola visualización" value={codes.join(' ')} onClear={() => setCodes([])} /> : null}
      <form onSubmit={onSubmit(enroll, setPending, setError)}>
        <h2>{enrollment || restricted ? 'Registrar factor de esta fase' : 'Añadir factor'}</h2>
        <Field label="Etiqueta"><input value={label} onChange={event => setLabel(event.target.value)} maxLength={60} required /></Field>
        <Field label="Tipo">
          <select value={methodType} onChange={event => setMethodType(event.target.value as 'TOTP' | 'WEBAUTHN')}>
            <option value="TOTP">TOTP</option>
            <option value="WEBAUTHN">Passkey</option>
          </select>
        </Field>
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
      <section className="card">
        <h2>Factores activos</h2>
        {factors.length === 0 ? <Empty>No hay factores activos en esta consulta.</Empty> : (
          <div className="cards">
            {factors.map(factor => (
              <article className="card" key={factor.id}>
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
      {strong ? (
        <>
          <form onSubmit={onSubmit(async () => {
            await reauthenticate({ password, purpose: 'RECOVERY_CODES_REGENERATE', code: stepCode });
            const result = await call<{ codes: string[] }>('POST', '/auth/mfa/recovery-codes/regenerate');
            setCodes(result.data.codes);
            setPassword(''); setStepCode('');
            setInfo('Códigos nuevos. Los anteriores dejaron de servir. Guárdalos fuera de este navegador.');
          }, setPending, setError)}>
            <h2>Regenerar códigos de recuperación</h2>
            <StepFields legend="Confirmar códigos nuevos" password={password} code={stepCode} setPassword={setPassword} setCode={setStepCode} />
            <Submit pending={pending}>Regenerar</Submit>
          </form>
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
          <section className="card">
            <h2>Sesiones</h2>
            {sessions.length === 0 ? <Empty>No hay sesiones operativas para mostrar.</Empty> : sessions.map(session => (
              <article className="card" key={session.id}>
                <h3>{session.deviceLabel}{session.current ? ' · esta sesión' : ''}</h3>
                <p>Visto {new Date(session.lastSeenAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
                <button type="button" onClick={() => void revoke(session).catch(setError)}>Cerrar esta sesión</button>
              </article>
            ))}
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
        </>
      ) : null}
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
