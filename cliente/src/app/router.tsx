import { useEffect, useState } from 'react';
import { AccessScreen } from '../features/access/Access';
import { FinanceScreen } from '../features/finance/Finance';
import { BorrowersScreen } from '../features/lending/Borrowers';
import { LoansScreen } from '../features/lending/Loans';
import { OrganizationScreen } from '../features/organization/Organization';
import { ActivateScreen, ProfileScreen } from '../features/profile/Profile';
import { SecurityScreen } from '../features/security/Security';

export const ROUTES = [
  { hash: '#/ingresar', label: 'Ingresar', group: 'public' },
  { hash: '#/registro', label: 'Crear cuenta', group: 'public' },
  { hash: '#/perfil', label: 'Perfil', group: 'session' },
  { hash: '#/seguridad', label: 'Seguridad', group: 'session' },
  { hash: '#/organizacion', label: 'Organización', group: 'strong' },
  { hash: '#/finanzas', label: 'Finanzas', group: 'strong' },
  { hash: '#/prestatarios', label: 'Prestatarios', group: 'strong' },
  { hash: '#/prestamos', label: 'Préstamos', group: 'strong' },
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
  const hash = route.split('?')[0] || '#/ingresar';
  if (hash === '#/seguridad') return <SecurityScreen />;
  if (hash === '#/organizacion') return <OrganizationScreen />;
  if (hash === '#/finanzas') return <FinanceScreen />;
  if (hash === '#/prestatarios') return <BorrowersScreen />;
  if (hash === '#/prestamos') return <LoansScreen />;
  if (hash === '#/perfil') return <ProfileScreen />;
  if (hash === '#/activar' || hash === '#/rechazar') return <ActivateScreen />;
  return <AccessScreen route={hash} />;
}
