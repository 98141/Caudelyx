import { useState } from 'react';
import { call, verifyPasskey } from '../../shared/api';
import { announceLogin, replaceHash, useAuth } from '../../shared/auth';
import { A19_WARNING, ApiError, isStrong, SYNTHETIC_POLICY_VERSION, type Me } from '../../shared/contracts';
import { Alert, ErrorText, Field, LocalMailboxHint, Panel, SecretTextField, Submit, onSubmit } from '../../shared/ui';
import { SocialSignInGroup } from './SocialSignIn';

function go(hash: string) { replaceHash(hash); }

export function RegisterForm() {
  const { me, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [exists, setExists] = useState(false);
  const admitted = me?.authState === 'EMAIL_REQUIRED' || me?.authState === 'PENDING_EMAIL';
  return (
    <Panel title="Crea tu cuenta" id="page-title">
      <p>Escribe tu nombre, el correo y la contraseña, y acepta la política. Si el alta es nueva, este navegador abre tu perfil. Si el correo ya existe, no se entra a esa cuenta.</p>
      <p className="muted">En esta prueba usa un correo @example.test. El enlace no llega por email real.</p>
      <LocalMailboxHint email={email || undefined} />
      <ErrorText error={error} />
      {admitted ? (
        <Alert tone="pending">
          Este navegador ya tiene un alta en curso. No se sustituye. Para usar otros datos, cierra la sesión y empieza otra alta.
          {' '}<a href="#/perfil">Ir al perfil</a>
        </Alert>
      ) : null}
      {exists ? <p><a href="#/ingresar">Ingresar</a> <a href="#/restablecer">Restablecer la contraseña</a></p> : null}
      {admitted ? null : (
      <form onSubmit={onSubmit(async () => {
        try {
          await call('POST', '/auth/register', {
            mode: 'PROFILE', email, displayName, password, privacyPolicyVersion: SYNTHETIC_POLICY_VERSION, acceptTerms: true,
          });
        } catch (caught) {
          if (caught instanceof ApiError && caught.status === 409 && caught.code === 'ACCOUNT_ALREADY_EXISTS') {
            setExists(true);
            setError(caught);
            return;
          }
          throw caught;
        }
        setPassword('');
        const next = await refresh();
        if (next?.authState === 'PENDING_EMAIL' || next?.authState === 'EMAIL_REQUIRED' || next?.sessionContext === 'B') go('#/perfil');
        else setError(new ApiError(401, 'AUTH_INVALID', null, 'El alta no abrió el perfil en este navegador. No se dio por iniciada otra cuenta.'));
      }, setPending, setError)}>
        <Field label="Correo"><input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="username" required /></Field>
        <Field label="Nombre visible"><input value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" minLength={1} maxLength={100} required /></Field>
        <SecretTextField label="Contraseña" value={password} onChange={setPassword} autoComplete="new-password" hint="Entre 15 y 128 caracteres. El servidor aplica la lista local." invalid={Boolean(error)} />
        <p className="muted">Política sintética local: {SYNTHETIC_POLICY_VERSION}</p>
        <label className="checks"><input type="checkbox" checked={acceptTerms} onChange={event => setAcceptTerms(event.target.checked)} required /> Acepto la política sintética local.</label>
        <Submit pending={pending}>Crear cuenta</Submit>
      </form>
      )}
      {admitted ? null : <p className="auth-switch"><a href="#/ingresar">Ya tengo cuenta: ingresar</a></p>}
    </Panel>
  );
}

export function VerifyForm() {
  return (
    <Panel title="Abrir el enlace" id="page-title">
      <p>La activación llega como enlace del canal local. Ábrelo en este navegador. No pegues el código aquí.</p>
      <p><a href="#/perfil">Ir al perfil</a> o <a href="#/ingresar">ingresar</a>.</p>
    </Panel>
  );
}

export function LoginForm() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [challenge, setChallenge] = useState(false);
  const [recoveryOngoing, setRecoveryOngoing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  async function afterLogin(data: Me) {
    setPassword(''); setCode('');
    if (data.authState === 'MFA_REQUIRED' || data.authState === 'RECOVERY_RESTRICTED' || data.authState === 'FACTOR_LOSS_BLOCKED') {
      setRecoveryOngoing(data.authState === 'RECOVERY_RESTRICTED');
      setChallenge(true); setInfo(data.authState === 'RECOVERY_RESTRICTED'
        ? 'Puedes comprobar un factor superviviente ya activo para terminar la recuperación. El factor pendiente no sirve para ingresar.'
        : data.authState === 'FACTOR_LOSS_BLOCKED'
          ? 'No hay factor activo. Puedes usar un código de recuperación válido; sin él no hay acceso ni reparación por correo.'
          : 'Contraseña comprobada. Falta el factor; no hay sesión de negocio.'); return;
    }
    setChallenge(false);
    const live = await refresh();
    if (!live?.userId) return;
    if (data.userId && live.userId !== data.userId) throw new ApiError(409, 'INVALID_STATE', null, 'La identidad cambió en el navegador. Revisa la sesión actual.');
    const session = live;
    announceLogin();
    if (session.authState === 'PENDING_EMAIL' || session.sessionContext === 'B' || session.authState === 'MFA_ENROLLMENT') go('#/perfil');
    else if (session.authState === 'ACTIVE' || session.authState === 'WORKING' || session.authState === 'AUTHENTICATED_NO_ORG' || session.authState === 'WORKING_NO_ORG') go('#/inicio');
  }
  return (
    <Panel title="Bienvenido de nuevo" id="page-title">
      <p className="auth-lead">Ingresa a tu cuenta para continuar</p>
      <p className="muted">La contraseña abre la sesión de trabajo. El factor se pide al mover dinero o al cambiar la seguridad.</p>
      <ErrorText error={error} />
      {info ? <Alert tone="pending">{info}</Alert> : null}
      <form onSubmit={onSubmit(async () => {
        if (!challenge) {
          try {
            const result = await call<Me>('POST', '/auth/login', { email, password });
            await afterLogin(result.data);
          } catch (caught) {
            if (caught instanceof ApiError && ['OFFLINE','SERVICE_UNAVAILABLE'].includes(caught.code)) {
              const live = await refresh();
              if (live?.userId && live.profile?.email?.toLowerCase() === email.trim().toLowerCase() && ['WORKING','WORKING_NO_ORG','ACTIVE','AUTHENTICATED_NO_ORG'].includes(live.authState)) { await afterLogin(live); return; }
            }
            throw caught;
          }
          return;
        }
        const result = await call<Me>('POST', '/auth/mfa/challenges/verify', { method: 'TOTP', purpose: 'LOGIN', code });
        setChallenge(false);
        await afterLogin(result.data);
      }, setPending, setError)}>
        <Field label="Correo"><input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="username" required disabled={challenge} aria-invalid={error ? true : undefined} /></Field>
        {!challenge ? <SecretTextField label="Contraseña" value={password} onChange={setPassword} autoComplete="current-password" invalid={Boolean(error)} /> : null}
        {challenge ? <Field label="Código TOTP vigente"><input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required aria-invalid={error ? true : undefined} /></Field> : null}
        {!challenge ? <p className="auth-links"><a href="#/restablecer">Olvidé la contraseña</a></p> : null}
        <Submit pending={pending}>{challenge ? 'Verificar factor' : 'Iniciar sesión'}</Submit>
      </form>
      {!challenge ? <SocialSignInGroup /> : null}
      {!challenge ? <p className="auth-switch">¿No tienes una cuenta? <a href="#/registro">Regístrate</a></p> : null}
      {!challenge ? <p className="auth-switch"><a href="#/invitacion">Aceptar invitación</a></p> : null}
      {challenge ? <button className="auth-secondary" type="button" disabled={pending} onClick={() => {
        setError(null); setPending(true);
        void verifyPasskey<Me>('LOGIN').then(result => afterLogin(result.data)).catch(setError).finally(() => setPending(false));
      }}>Comprobar passkey</button> : null}
      {challenge && !recoveryOngoing ? (
        <form onSubmit={onSubmit(async () => {
          const result = await call<Me>('POST', '/auth/mfa/recovery/start', { recoveryCode });
          setRecoveryCode(''); setChallenge(false);
          await refresh();
          setInfo('Recuperación restringida iniciada. El factor pendiente todavía no sirve para entrar.');
          if (result.data.authState === 'RECOVERY_RESTRICTED') go('#/seguridad');
        }, setPending, setError)}>
          <Alert tone="pending">El código se consume aunque no completes la recuperación. Si era tu último código y no conservas un factor utilizable, podrías quedar sin acceso; no hay reparación disponible en esta fase</Alert>
          <p>La recuperación dura 15 minutos absolutos y no se renueva.</p>
          <Field label="Código de recuperación" hint="Solo si acabas de comprobar la contraseña. No sustituye un factor activo.">
            <input value={recoveryCode} onChange={event => setRecoveryCode(event.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Submit pending={pending}>Iniciar recuperación restringida</Submit>
        </form>
      ) : null}
    </Panel>
  );
}

export function ResetForm() {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [warningRequired, setWarningRequired] = useState<boolean | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Panel title="Restablecer contraseña" id="page-title">
      <p>Primero se solicita el código. Después hay que previsualizar el aviso y confirmar con el mismo código.</p>
      <ErrorText error={error} />
      {done ? <Alert tone="pending">{done}</Alert> : null}
      <form onSubmit={onSubmit(async () => {
        await call('POST', '/auth/password-reset/request', { email });
        setDone('Si la solicitud es admisible, habrá un código. Esto no cambia la contraseña.');
      }, setPending, setError)}>
        <Field label="Correo"><input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="username" required /></Field>
        <Submit pending={pending}>Solicitar código</Submit>
      </form>
      <form onSubmit={onSubmit(async () => {
        const result = await call<{ warningRequired: boolean; warningMessage: string | null }>('POST', '/auth/password-reset/confirm', { mode: 'PREVIEW', token });
        setWarningRequired(result.data.warningRequired);
        setWarningMessage(result.data.warningMessage);
        setAcknowledged(false);
        setDone(null);
      }, setPending, setError)}>
        <Field label="Código de restablecimiento"><input value={token} onChange={event => { setToken(event.target.value); setWarningRequired(null); }} autoComplete="one-time-code" spellCheck={false} minLength={43} maxLength={43} required /></Field>
        <Submit pending={pending}>Previsualizar aviso</Submit>
      </form>
      {warningRequired !== null ? (
        <form onSubmit={onSubmit(async () => {
          await call('POST', '/auth/password-reset/confirm', { mode: 'CONFIRM', token, newPassword, warningAcknowledged: warningRequired });
          setToken(''); setNewPassword(''); setWarningRequired(null); setWarningMessage(null);
          setDone('Contraseña actualizada. Las sesiones quedaron cerradas. Vuelve a ingresar; no hay sesión de negocio abierta.');
        }, setPending, setError)}>
          {warningRequired ? <Alert tone="pending">{warningMessage === A19_WARNING ? warningMessage : 'El aviso del servidor no coincide con el texto esperado. No confirmes hasta revisar el canal.'}</Alert> : <Alert tone="info">El servidor no pidió el aviso de bloqueo. Si nunca hubo factor ni organización, después de ingresar se puede registrar el primero.</Alert>}
          {warningRequired ? <label className="checks"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} required /> Entiendo el aviso y quiero continuar.</label> : null}
          <SecretTextField label="Contraseña nueva" value={newPassword} onChange={setNewPassword} autoComplete="new-password" invalid={Boolean(error)} />
          <Submit pending={pending}>Confirmar restablecimiento</Submit>
        </form>
      ) : null}
    </Panel>
  );
}

export function InvitationForm() {
  const { me, refresh } = useAuth();
  const [token, setToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const strong = isStrong(me);
  return (
    <Panel title="Invitación" id="page-title">
      <p>Preparar una invitación no entrega contraseña, sesión ni afiliación. Confirmar exige una sesión de trabajo con correo confirmado y que corresponda al destinatario.</p>
      <ErrorText error={error} />
      {done ? <Alert tone="pending">{done}</Alert> : null}
      <form onSubmit={onSubmit(async () => {
        await call('POST', '/auth/invitations/accept', { mode: 'PREPARE', token, displayName, privacyPolicyVersion: SYNTHETIC_POLICY_VERSION, acceptTerms: true });
        setToken(''); setDisplayName('');
        setDone('Solicitud de preparación recibida. No hay credencial ni membresía.');
      }, setPending, setError)}>
        <h2>Preparar</h2>
        <Field label="Código de invitación"><input value={token} onChange={event => setToken(event.target.value)} autoComplete="one-time-code" spellCheck={false} minLength={43} maxLength={43} required /></Field>
        <Field label="Nombre visible"><input value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" maxLength={100} /></Field>
        <label className="checks"><input type="checkbox" required /> Acepto la política sintética local {SYNTHETIC_POLICY_VERSION}.</label>
        <Submit pending={pending}>Preparar invitación</Submit>
      </form>
      <form onSubmit={onSubmit(async () => {
        await call('POST', '/auth/invitations/accept', { mode: 'CONFIRM', token });
        setToken('');
        await refresh();
        setDone('Invitación confirmada por el servidor. El contexto de afiliación se ha actualizado.');
      }, setPending, setError)}>
        <h2>Confirmar</h2>
        {!strong ? <Alert tone="info">Hace falta ingresar con correo confirmado antes de confirmar. El servidor comprueba el destinatario y la invitación.</Alert> : null}
        <Field label="Código de invitación"><input value={token} onChange={event => setToken(event.target.value)} autoComplete="one-time-code" spellCheck={false} minLength={43} maxLength={43} required /></Field>
        <Submit pending={pending}>Confirmar invitación</Submit>
      </form>
    </Panel>
  );
}

export function AccessScreen({ route }: { route: string }) {
  if (route === '#/registro') return <RegisterForm />;
  if (route === '#/verificar') return <VerifyForm />;
  if (route === '#/restablecer') return <ResetForm />;
  if (route === '#/invitacion') return <InvitationForm />;
  return <LoginForm />;
}
