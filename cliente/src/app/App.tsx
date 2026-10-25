import { useEffect, type ReactNode } from 'react';
import { AuthBrand, AuthWordmark } from '../features/access/AuthBrand';
import { useAuth } from '../shared/auth';
import { isStrong } from '../shared/contracts';
import { Alert } from '../shared/ui';
import { AppShell, NavIcon } from './AppShell';
import { ROUTES, Screen, useHashRoute } from './router';

const ACCESS_ROUTES = new Set(['#/ingresar', '#/registro', '#/verificar', '#/restablecer', '#/invitacion']);

function isAccessRoute(route: string): boolean {
  return ACCESS_ROUTES.has(route.split('?')[0] || '#/ingresar');
}

function stateText(state: string | undefined): string | null {
  if (state === 'PENDING_EMAIL') return 'Correo sin confirmar. Esta sesión no abre la organización ni las finanzas.';
  if (state === 'MFA_ENROLLMENT') return 'Falta registrar el primer factor. La contraseña no abre el acceso de negocio.';
  if (state === 'MFA_REQUIRED') return 'Falta verificar el factor. La contraseña sola no es suficiente.';
  if (state === 'RECOVERY_RESTRICTED') return 'Recuperación restringida. No hay acceso a la organización ni a datos de negocio.';
  if (state === 'FACTOR_LOSS_BLOCKED') return 'No hay un factor activo. El acceso de negocio permanece cerrado.';
  if (state === 'AUTHENTICATED_NO_ORG') return 'Sesión comprobada, sin organización. El siguiente paso es crearla.';
  if (state === 'ACTIVE') return 'Sesión de organización activa.';
  return null;
}

export function App() {
  const route = useHashRoute();
  const { me, phase, online, logout } = useAuth();
  useEffect(() => {
    document.getElementById('page-title')?.focus();
  }, [route]);
  const links = ROUTES.filter(item => {
    if (item.hash === '#/seguridad') return false;
    if (phase === 'loading' || phase === 'offline') return false;
    if (item.group === 'public') return phase === 'anonymous';
    if (item.group === 'session') return phase === 'ready';
    return phase === 'ready' && isStrong(me);
  });
  const currentHash = route.split('?')[0];
  const notice = stateText(me?.authState);
  const navigation = (
    <nav id="app-nav" aria-label="Secciones">
      {phase === 'ready' ? <p className="nav-hello">{me?.profile?.displayName ? `Hola, ${me.profile.displayName}` : 'Hola'}</p> : null}
      <div className="nav-links">
        {links.map(item => (
          <a key={item.hash} href={item.hash} aria-current={currentHash === item.hash || (item.hash === '#/perfil' && currentHash === '#/seguridad') ? 'page' : undefined}>
            <NavIcon hash={item.hash} />
            <span>{item.label}</span>
          </a>
        ))}
      </div>
      {phase === 'ready' ? <button type="button" onClick={() => void logout()}>Cerrar sesión</button> : null}
    </nav>
  );
  const content = (
    <main id="contenido" tabIndex={-1}>
      {!online ? <Alert tone="error">Sin conexión. No se confirmará ninguna operación hasta recuperar la red.</Alert> : null}
      {phase === 'loading' ? <p role="status">Cargando sesión…</p> : null}
      {phase === 'offline' ? <Alert tone="error">No se pudo consultar la sesión. No hay un acceso confirmado.</Alert> : null}
      {notice ? <Alert tone={me?.authState === 'ACTIVE' ? 'ok' : 'pending'}>{notice}{me?.expiresAt ? ` Vence ${new Date(me.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.` : ''}</Alert> : null}
      <Screen route={route} />
    </main>
  );
  return (
    <>
      <a className="skip" href="#contenido" onClick={event => {
        event.preventDefault();
        document.getElementById('contenido')?.focus();
      }}>Saltar al contenido</a>
      {isAccessRoute(route) ? <AuthStage navigation={navigation}>{content}</AuthStage> : <AppShell route={route} navigation={navigation}>{content}</AppShell>}
    </>
  );
}

function AuthStage({ navigation, children }: { navigation: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-stage">
      <AuthBrand />
      <div className="auth-main">
        <div className="auth-card">
          <AuthWordmark />
          {children}
          {navigation}
        </div>
      </div>
    </div>
  );
}
