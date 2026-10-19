import { useEffect } from 'react';
import { useAuth } from '../shared/auth';
import { isStrong } from '../shared/contracts';
import { Alert } from '../shared/ui';
import { ROUTES, Screen, useHashRoute } from './router';

function stateText(state: string | undefined): string | null {
  if (state === 'MFA_ENROLLMENT') return 'Falta registrar el primer factor. La contraseña no abre el acceso de negocio.';
  if (state === 'MFA_REQUIRED') return 'Falta verificar el factor. La contraseña sola no es suficiente.';
  if (state === 'RECOVERY_RESTRICTED') return 'Recuperación restringida. No hay acceso a la organización ni a datos de negocio.';
  if (state === 'FACTOR_LOSS_BLOCKED') return 'No hay un factor activo. El acceso de negocio permanece cerrado.';
  if (state === 'AUTHENTICATED_NO_ORG') return 'Sesión comprobada, sin organización. Los módulos financieros no están activos.';
  if (state === 'ACTIVE') return 'Sesión de organización activa. Los módulos financieros no forman parte de esta fase.';
  return null;
}

export function App() {
  const route = useHashRoute();
  const { me, phase, online, logout } = useAuth();
  useEffect(() => {
    document.getElementById('page-title')?.focus();
  }, [route]);
  const links = ROUTES.filter(item => {
    if (item.group === 'public') return true;
    if (item.group === 'session') return phase === 'ready';
    return isStrong(me);
  });
  const notice = stateText(me?.authState);
  return (
    <>
      <a className="skip" href="#contenido" onClick={event => {
        event.preventDefault();
        document.getElementById('contenido')?.focus();
      }}>Saltar al contenido</a>
      <div className="shell">
        <header className="top">
          <p className="brand">Caudelyx</p>
          <p>Acceso, factores y organización. Esta fase no opera préstamos, caja ni patrimonio.</p>
        </header>
        <div className="frame">
          <nav aria-label="Secciones">
            {links.map(item => (
              <a key={item.hash} href={item.hash} aria-current={route === item.hash ? 'page' : undefined}>{item.label}</a>
            ))}
            {phase === 'ready' ? <button type="button" onClick={() => void logout()}>Cerrar sesión</button> : null}
          </nav>
          <main id="contenido" tabIndex={-1}>
            {!online ? <Alert tone="error">Sin conexión. No se confirmará ninguna operación hasta recuperar la red.</Alert> : null}
            {phase === 'loading' ? <p role="status">Cargando sesión…</p> : null}
            {phase === 'offline' ? <Alert tone="error">No se pudo consultar la sesión. No hay un acceso confirmado.</Alert> : null}
            {notice ? <Alert tone={me?.authState === 'ACTIVE' ? 'ok' : 'pending'}>{notice}{me?.expiresAt ? ` Vence ${new Date(me.expiresAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}.` : ''}</Alert> : null}
            <Screen route={route} />
          </main>
        </div>
      </div>
    </>
  );
}
