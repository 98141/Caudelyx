import { useEffect, useState } from 'react';
import { clearActivationLink, peekActivation } from '../../shared/activation-link';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, isStrong, type Me } from '../../shared/contracts';
import { Alert, ErrorText, Panel, SecretTextField, Submit, onSubmit } from '../../shared/ui';
import { FirstFactorSetup } from '../security/Security';

function go(hash: string) { window.location.hash = hash; }

export function ProfileScreen() {
  const { me, phase } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  const [initialSent, setInitialSent] = useState(false);
  const provisional = me?.authState === 'EMAIL_REQUIRED';
  const canEnroll = me?.nextAction === 'ENROLL_FIRST_FACTOR';
  const needsInitial = me?.authState === 'MFA_ENROLLMENT' && !canEnroll;
  return (
    <Panel title="Perfil" id="page-title">
      {phase === 'loading' ? <p role="status">Cargando sesión…</p> : null}
      {provisional ? <Alert tone="pending">Activa tu cuenta para continuar.</Alert> : null}
      <ErrorText error={error} />
      {me?.profile ? (
        <>
          <p>Nombre: {me.profile.displayName}</p>
          <p>Correo: {me.profile.email}</p>
          <p>{provisional ? 'Esta solicitud todavía no está activada.' : me.profile.emailVerified ? 'Correo confirmado en tu cuenta.' : 'El correo de esta cuenta sigue pendiente.'}</p>
        </>
      ) : phase === 'anonymous' ? <p>No hay un perfil en este navegador. <a href="#/registro">Crear cuenta</a> o <a href="#/ingresar">ingresar</a>.</p> : null}
      {provisional && me.profile ? (
        <>
          <p>Estos datos son los del intento de este navegador. Para cambiarlos, cierra la sesión y empieza otra alta.</p>
          <button type="button" disabled={pending} onClick={() => {
            setError(null); setPending(true);
            void call('POST', '/auth/email-verifications/request', { purpose: 'ACTIVATION', email: me.profile?.email })
              .then(() => setSent(true)).catch(setError).finally(() => setPending(false));
          }}>Reenviar enlace de activación</button>
          {sent ? <Alert tone="pending">Solicitud recibida. Revisa el canal local. Esto no dice si el correo existe.</Alert> : null}
          <p><a href="#/ingresar">Ya tengo cuenta: ingresar</a></p>
        </>
      ) : null}
      {needsInitial ? (
        <section>
          <h2>Proteger mi cuenta</h2>
          <p>Este ingreso no trae el alta del factor. Pide un enlace nuevo y ábrelo en este mismo navegador.</p>
          <button type="button" disabled={pending} onClick={() => {
            setError(null); setPending(true);
            void call('POST', '/auth/email-verifications/request', { purpose: 'INITIAL_MFA_PROOF' })
              .then(() => setInitialSent(true)).catch(setError).finally(() => setPending(false));
          }}>Pedir enlace de protección</button>
          {initialSent ? <Alert tone="pending">Solicitud recibida. Abre el enlace del canal local en este mismo ingreso. Esto no abre la organización.</Alert> : null}
        </section>
      ) : null}
      {canEnroll ? <FirstFactorSetup /> : null}
      {me?.authState === 'MFA_REQUIRED' ? <p>Falta comprobar el factor que ya tienes. <a href="#/ingresar">Ingresar</a></p> : null}
      {me?.authState === 'FACTOR_LOSS_BLOCKED' || me?.authState === 'RECOVERY_RESTRICTED' ? <p><a href="#/seguridad">Revisar la seguridad de la cuenta</a></p> : null}
      {isStrong(me) ? <p><a href="#/organizacion">Continuar a la organización</a></p> : null}
    </Panel>
  );
}

export function ActivateScreen() {
  const { me, phase, refresh, logout } = useAuth();
  const [, setLinkTick] = useState(0);
  useEffect(() => {
    const sync = () => {
      setLinkTick(value => value + 1);
      if (peekActivation()?.status === 'ready') {
        setLegacyRequired(false);
        setLegacyConfirmed(false);
        setLegacyFailed(false);
        setPassword('');
        setError(null);
      }
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const link = peekActivation();
  const [password, setPassword] = useState('');
  const [legacyConfirmed, setLegacyConfirmed] = useState(false);
  const [legacyRequired, setLegacyRequired] = useState(false);
  const [legacyFailed, setLegacyFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [initialBlocked, setInitialBlocked] = useState(false);
  const ready = link?.status === 'ready' ? link : null;
  const initialOriginal = me?.authState === 'MFA_ENROLLMENT' && me.nextAction !== 'ENROLL_FIRST_FACTOR';

  useEffect(() => {
    if (phase === 'loading' || !ready || ready.purpose !== 'INITIAL_MFA_PROOF' || initialOriginal) return;
    clearActivationLink();
    setInitialBlocked(true);
  }, [phase, ready, initialOriginal]);

  async function finish() {
    setPassword('');
    clearActivationLink();
    await refresh();
    go('#/perfil');
  }

  if (phase === 'loading') return <Panel title="Activar" id="page-title"><p role="status">Cargando sesión…</p></Panel>;
  if (legacyFailed) {
    return (
      <Panel title="Activar" id="page-title">
        <ErrorText error={error} />
        <p>No se activó la cuenta. Puedes empezar un alta nueva.</p>
        <p><a href="#/registro">Empezar un alta nueva</a></p>
      </Panel>
    );
  }
  if (initialBlocked) {
    return (
      <Panel title="Activar" id="page-title">
        <p>Este enlace solo vale en el ingreso donde se pidió. Si saliste o cambiaste de cuenta, pide otro. No se usó este.</p>
        <p><a href="#/ingresar">Volver a ingresar</a></p>
      </Panel>
    );
  }
  if (!link) {
    return <Panel title="Activar" id="page-title"><p>Abre el enlace del canal local. No pegues el código en esta página.</p></Panel>;
  }
  if (link.status === 'invalid' || !ready) {
    return <Panel title="Activar" id="page-title"><Alert tone="error">Este enlace no se puede usar. Pide otro en el canal local. No pegues el código.</Alert></Panel>;
  }

  if (ready.purpose === 'INITIAL_MFA_PROOF' && !initialOriginal) {
    return (
      <Panel title="Activar" id="page-title">
        <p>Este enlace solo vale en el ingreso donde se pidió. Si saliste o cambiaste de cuenta, pide otro. No se usó este.</p>
        <p><a href="#/ingresar">Volver a ingresar</a></p>
      </Panel>
    );
  }

  if (ready.purpose === 'INITIAL_MFA_PROOF') {
    return (
      <Panel title="Activar" id="page-title">
        <p>Confirma el enlace para poder proteger la cuenta. No se envía otra contraseña.</p>
        <ErrorText error={error} />
        <form onSubmit={onSubmit(async () => {
          const live = peekActivation();
          if (!live || live.status !== 'ready') return;
          await call<Me>('POST', '/auth/email-verifications/confirm', { purpose: 'INITIAL_MFA_PROOF', token: live.token });
          await finish();
        }, setPending, setError)}>
          <Submit pending={pending}>Confirmar enlace</Submit>
        </form>
      </Panel>
    );
  }

  if (me && me.authState !== 'EMAIL_REQUIRED') {
    return (
      <Panel title="Activar" id="page-title">
        <p>Hay otra cuenta en este navegador. Sal antes de activar. No se cambia de cuenta en silencio.</p>
        <button type="button" onClick={() => void logout().then(() => go('#/activar'))}>Cerrar sesión</button>
        <p>Después abre de nuevo el enlace del canal local.</p>
      </Panel>
    );
  }

  if (me?.authState === 'EMAIL_REQUIRED' && !legacyRequired) {
    return (
      <Panel title="Activar" id="page-title">
        <p>Confirma el enlace de esta alta. La contraseña ya quedó en el intento de este navegador.</p>
        <ErrorText error={error} />
        <form onSubmit={onSubmit(async () => {
          const live = peekActivation();
          if (!live || live.status !== 'ready') return;
          try {
            await call<Me>('POST', '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', mode: 'LINK', token: live.token });
            await finish();
          } catch (error) {
            if (error instanceof ApiError && error.status === 401 && error.code === 'TOKEN_INVALID') {
              setLegacyRequired(true);
              setError(error);
            } else throw error;
          }
        }, setPending, setError)}>
          <Submit pending={pending}>Activar cuenta</Submit>
        </form>
      </Panel>
    );
  }

  if (!legacyConfirmed) {
    return (
      <Panel title="Activar" id="page-title">
        <p>{legacyRequired
          ? 'El alta de este navegador ya no sirve para este enlace. Puedes crear tu contraseña inicial con este mismo enlace.'
          : 'No hay un alta provisional vigente en este navegador. Si se perdió o caducó, puedes crear la contraseña inicial en este mismo enlace. El servidor decide si sigue sirviendo.'}</p>
        <ErrorText error={error} />
        <button type="button" onClick={() => setLegacyConfirmed(true)}>Crear contraseña inicial</button>
        <p><a href="#/registro">Empezar un alta nueva</a></p>
      </Panel>
    );
  }

  return (
    <Panel title="Activar" id="page-title">
      <p>La contraseña inicial solo se envía porque elegiste usar la alternativa de este enlace.</p>
      <ErrorText error={error} />
      <form onSubmit={onSubmit(async () => {
        const live = peekActivation();
        if (!live || live.status !== 'ready') return;
        try {
          await call<Me>('POST', '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token: live.token, newPassword: password });
          await finish();
        } catch (error) {
          setLegacyFailed(true);
          throw error;
        } finally {
          setPassword('');
          clearActivationLink();
        }
      }, setPending, setError)}>
        <SecretTextField label="Contraseña nueva" value={password} onChange={setPassword} autoComplete="new-password" hint="Entre 15 y 128 caracteres. El servidor aplica la lista local." />
        <Submit pending={pending}>Activar con contraseña inicial</Submit>
      </form>
    </Panel>
  );
}
