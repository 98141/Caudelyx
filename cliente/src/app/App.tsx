import { useEffect, type ReactNode } from 'react';
import { AuthBrand, AuthWordmark } from '../features/access/AuthBrand';
import { replaceHash, useAuth } from '../shared/auth';
import { isStrong } from '../shared/contracts';
import { FlashBanner } from '../shared/flash';
import { useSessionActivity } from '../shared/session-activity';
import { StepUpProvider } from '../shared/step-up';
import { localSynthetic } from '../shared/local-mode';
import { Alert } from '../shared/ui';
import { AppShell, NavIcon } from './AppShell';
import { ROUTES, Screen, useHashRoute } from './router';

const ACCESS_ROUTES = new Set(['#/ingresar', '#/registro', '#/verificar', '#/restablecer']);
const OPEN_ROUTES = new Set(['#/ingresar', '#/registro', '#/verificar', '#/restablecer', '#/activar', '#/rechazar', '#/invitacion']);

function bare(route: string): string {
  return route.split('?')[0] || '#/ingresar';
}

function stateText(state: string | undefined): string | null {
  if (state === 'PENDING_EMAIL') return 'Correo sin confirmar. Esta sesión no abre la organización ni las finanzas.';
  if (state === 'MFA_ENROLLMENT') return 'Falta registrar el primer factor. La contraseña no abre el acceso de negocio.';
  if (state === 'MFA_REQUIRED') return 'Falta verificar el factor. La contraseña sola no es suficiente.';
  if (state === 'RECOVERY_RESTRICTED') return 'Recuperación restringida. No hay acceso a la organización ni a datos de negocio.';
  if (state === 'FACTOR_LOSS_BLOCKED') return 'No hay un factor activo. El acceso de negocio permanece cerrado.';
  if (state === 'AUTHENTICATED_NO_ORG' || state === 'WORKING_NO_ORG') return 'Sesión comprobada, sin organización. El siguiente paso es crearla.';
  return null;
}

export function App() {
  const route = useHashRoute();
  const { me, phase, online, clock, logoutNotice, logout, expire, retryLogout, applySession } = useAuth();
  const hash = bare(route);
  const activity = useSessionActivity({
    enabled: phase === 'ready' && Boolean(clock),
    clock,
    onSession: applySession,
    onExpired: expire,
  });
  useEffect(() => {
    document.getElementById('page-title')?.focus();
  }, [route]);
  useEffect(() => {
    if (phase === 'loading' || phase === 'offline') return;
    if (phase === 'anonymous' && !OPEN_ROUTES.has(hash)) replaceHash('#/ingresar');
    if (phase === 'ready' && (hash === '#/ingresar' || hash === '#/registro')) {
      if (me?.authState === 'PENDING_EMAIL' || me?.sessionContext === 'B') replaceHash('#/perfil');
      else if (isStrong(me)) replaceHash('#/inicio');
    }
  }, [phase, hash, me]);
  const links = ROUTES.filter(item => {
    if (item.hash === '#/seguridad') return false;
    if (phase !== 'ready') return false;
    if (item.group === 'public') return false;
    if (item.group === 'session') return true;
    return isStrong(me);
  });
  const notice = stateText(me?.authState);
  const localMode = localSynthetic();
  const showPrivateNav = phase === 'ready' && !ACCESS_ROUTES.has(hash);
  const navigation = showPrivateNav ? (
    <nav id="app-nav" aria-label="Secciones">
      {me?.profile?.displayName ? <p className="nav-hello">Hola, {me.profile.displayName}</p> : <p className="nav-hello">Hola</p>}
      <div className="nav-links">
        {links.map(item => (
          <a key={item.hash} href={item.hash} aria-current={hash === item.hash || (item.hash === '#/perfil' && hash === '#/seguridad') ? 'page' : undefined}>
            <NavIcon hash={item.hash} />
            <span>{item.label}</span>
          </a>
        ))}
      </div>
      <button type="button" onClick={() => void logout()}>Cerrar sesión</button>
    </nav>
  ) : null;
  const blockedScreen = phase === 'anonymous' && !OPEN_ROUTES.has(hash);
  const content = (
    <main id="contenido" tabIndex={-1}>
      <FlashBanner />
      {localMode ? <Alert tone="pending">Modo local sintético. No es un uso real ni una cartera de clientes.</Alert> : null}
      {!online ? <Alert tone="error">Sin conexión. No se confirmará ninguna operación hasta recuperar la red.</Alert> : null}
      {logoutNotice ? <Alert tone="error">{logoutNotice} {logoutNotice.includes('Reintentar') ? <button type="button" onClick={() => void retryLogout()}>Reintentar</button> : null}</Alert> : null}
      {phase === 'loading' ? <p role="status">Cargando sesión…</p> : null}
      {phase === 'offline' ? <Alert tone="error">No se pudo consultar la sesión. No hay un acceso confirmado.</Alert> : null}
      {activity.state?.warning ? (
        <Alert tone="pending">
          La sesión de trabajo está por vencer.
          {activity.state.absoluteBinds ? ' El límite de 12 horas no se alarga.' : null}
          {' '}
          <button type="button" data-session-activity="explicit" onClick={() => void activity.stayConnected().catch(() => undefined)}>Seguir conectado</button>
        </Alert>
      ) : null}
      {phase === 'ready' && notice ? <Alert tone="pending">{notice}</Alert> : null}
      {phase === 'loading' || blockedScreen || route.includes('salida=pendiente') ? null : <Screen key={`${me?.userId ?? 'anon'}:${me?.organizationId ?? 'none'}:${phase}`} route={route} />}
    </main>
  );
  return (
    <StepUpProvider>
      <a className="skip" href="#contenido" onClick={event => {
        event.preventDefault();
        document.getElementById('contenido')?.focus();
      }}>Saltar al contenido</a>
      {ACCESS_ROUTES.has(hash) ? <AuthStage>{content}</AuthStage> : <AppShell route={route} navigation={navigation}>{content}</AppShell>}
    </StepUpProvider>
  );
}

function AuthStage({ children }: { children: ReactNode }) {
  return (
    <div className="auth-stage">
      <AuthBrand />
      <div className="auth-main">
        <div className="auth-card">
          <AuthWordmark />
          {children}
        </div>
      </div>
    </div>
  );
}
