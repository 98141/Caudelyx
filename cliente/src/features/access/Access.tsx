import { useState } from 'react';
import { call, verifyPasskey } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { A19_WARNING, SYNTHETIC_POLICY_VERSION, type Me } from '../../shared/contracts';
import { Alert, ErrorText, Field, Panel, SecretTextField, Submit, onSubmit } from '../../shared/ui';

function go(hash: string) { window.location.hash = hash; }

export function RegisterForm() {
  const { me, refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [accepted, setAccepted] = useState(false);
  const admitted = me?.authState === 'EMAIL_REQUIRED';
  return (
    <Panel title="Crea tu cuenta" id="page-title">
      <p>Escribe tu nombre, el correo y la contraseña, y acepta la política. Un envío no confirma que la cuenta exista ni abre una sesión.</p>
      <p className="muted">En esta prueba usa un correo @example.test. El enlace no llega por email real. En otra terminal, dentro de la carpeta del producto, ejecuta npm run mailbox -- --email y el correo de esta solicitud. El enlace se imprime solo allí. Ábrelo en este navegador. Esta pantalla no lo muestra ni marca el correo como confirmado.</p>
      <ErrorText error={error} />
      {admitted ? (
        <Alert tone="pending">
          Este navegador ya tiene un alta en curso. No se sustituye. Para usar otros datos, cierra la sesión y empieza otra alta.
          {' '}<a href="#/perfil">Ir al perfil provisional</a>
        </Alert>
      ) : null}
      {accepted && !admitted ? (
        <Alert tone="pending">Solicitud recibida. Esto no confirma que la cuenta exista ni que hayas entrado. No hay un perfil provisional en este navegador.</Alert>
      ) : null}
      {admitted || accepted ? null : (
      <form onSubmit={onSubmit(async () => {
        await call('POST', '/auth/register', {
          mode: 'PROFILE', email, displayName, password, privacyPolicyVersion: SYNTHETIC_POLICY_VERSION, acceptTerms: true,
        });
        setPassword('');
        const next = await refresh();
        setAccepted(true);
        if (next?.authState === 'EMAIL_REQUIRED') go('#/perfil');
      }, setPending, setError)}>
        <Field label="Correo"><input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="username" required /></Field>
        <Field label="Nombre visible"><input value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" minLength={1} maxLength={100} required /></Field>
        <SecretTextField label="Contraseña" value={password} onChange={setPassword} autoComplete="new-password" hint="Entre 15 y 128 caracteres. El servidor aplica la lista local." />
        <p className="muted">Política sintética local: {SYNTHETIC_POLICY_VERSION}</p>
        <label className="checks"><input type="checkbox" checked={acceptTerms} onChange={event => setAcceptTerms(event.target.checked)} required /> Acepto la política sintética local.</label>
        <Submit pending={pending}>Crear cuenta</Submit>
      </form>
      )}
      <p><a href="#/ingresar">Ya tengo cuenta: ingresar</a></p>
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
    await refresh();
    if (data.authState === 'MFA_ENROLLMENT') go('#/perfil');
    if (data.authState === 'ACTIVE' || data.authState === 'AUTHENTICATED_NO_ORG') go('#/organizacion');
  }
  return (
    <Panel title="Ingresar" id="page-title">
      <p>La contraseña sola no confirma el acceso de negocio.</p>
      <ErrorText error={error} />
      {info ? <Alert tone="pending">{info}</Alert> : null}
      <form onSubmit={onSubmit(async () => {
        if (!challenge) {
          const result = await call<Me>('POST', '/auth/login', { email, password });
          await afterLogin(result.data);
          return;
        }
        const result = await call<Me>('POST', '/auth/mfa/challenges/verify', { method: 'TOTP', purpose: 'LOGIN', code });
        setChallenge(false);
        await afterLogin(result.data);
      }, setPending, setError)}>
        <Field label="Correo"><input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="username" required disabled={challenge} /></Field>
        {!challenge ? <Field label="Contraseña"><input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" minLength={15} maxLength={128} required /></Field> : null}
        {challenge ? <Field label="Código TOTP vigente"><input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required /></Field> : null}
        <Submit pending={pending}>{challenge ? 'Verificar factor' : 'Continuar'}</Submit>
      </form>
      {!challenge ? <p><a href="#/restablecer">Olvidé la contraseña</a></p> : null}
      {challenge ? <button type="button" disabled={pending} onClick={() => {
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
          {warningRequired ? <Alert tone="pending">{warningMessage === A19_WARNING ? warningMessage : 'El aviso del servidor no coincide con el texto esperado. No confirmes hasta revisar el canal.'}</Alert> : <Alert tone="info">Este restablecimiento no exige el aviso de primer factor.</Alert>}
          {warningRequired ? <label className="checks"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} required /> Entiendo el aviso y quiero continuar.</label> : null}
          <Field label="Contraseña nueva"><input value={newPassword} onChange={event => setNewPassword(event.target.value)} type="password" autoComplete="new-password" minLength={15} maxLength={128} required /></Field>
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
  const strong = me?.authState === 'ACTIVE' || me?.authState === 'AUTHENTICATED_NO_ORG';
  return (
    <Panel title="Invitación" id="page-title">
      <p>Preparar una invitación no entrega contraseña, sesión ni afiliación. Confirmar exige una sesión ya comprobada con factor y el correo destinatario.</p>
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
        {!strong ? <Alert tone="info">Hace falta ingresar con factor antes de confirmar. El formulario no simula ese permiso.</Alert> : null}
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
