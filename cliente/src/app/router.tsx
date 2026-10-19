import { useEffect, useState } from 'react';
import { AccessScreen } from '../features/access/Access';
import { OrganizationScreen } from '../features/organization/Organization';
import { SecurityScreen } from '../features/security/Security';

export const ROUTES = [
  { hash: '#/ingresar', label: 'Ingresar', group: 'public' },
  { hash: '#/registro', label: 'Registro', group: 'public' },
  { hash: '#/verificar', label: 'Verificar correo', group: 'public' },
  { hash: '#/restablecer', label: 'Restablecer contraseña', group: 'public' },
  { hash: '#/invitacion', label: 'Invitación', group: 'public' },
  { hash: '#/seguridad', label: 'Seguridad', group: 'session' },
  { hash: '#/organizacion', label: 'Organización', group: 'strong' },
] as const;

export function useHashRoute(): string {
  const [route, setRoute] = useState(window.location.hash || '#/ingresar');
  useEffect(() => {
    const sync = () => setRoute(window.location.hash || '#/ingresar');
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return route;
}

export function Screen({ route }: { route: string }) {
  if (route === '#/seguridad') return <SecurityScreen />;
  if (route === '#/organizacion') return <OrganizationScreen />;
  return <AccessScreen route={route} />;
}
