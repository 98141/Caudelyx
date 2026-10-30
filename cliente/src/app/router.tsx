import { useEffect, useState } from 'react';
import { HomeScreen } from '../features/home/Home';
import { SettingsScreen } from '../features/settings/Settings';
import { FinanceScreen } from '../features/finance/Finance';
import { BorrowersScreen } from '../features/lending/Borrowers';
import { LoansScreen } from '../features/lending/Loans';
import { AccessScreen } from '../features/access/Access';
import { OperationsScreen } from '../features/lending/Operations';
import { PaymentsScreen } from '../features/lending/Payments';
import { CollectionsScreen } from '../features/lending/Collections';
import { ReportingScreen } from '../features/lending/Reporting';
import { ObligationsScreen } from '../features/lending/Obligations';
import { WealthScreen } from '../features/lending/Wealth';
import { OrganizationScreen } from '../features/organization/Organization';
import { ActivateScreen, ProfileScreen } from '../features/profile/Profile';
import { SecurityScreen } from '../features/security/Security';

export const ROUTES = [
  { hash: '#/ingresar', label: 'Ingresar', group: 'public' },
  { hash: '#/registro', label: 'Crear cuenta', group: 'public' },
  { hash: '#/inicio', label: 'Inicio', group: 'session' },
  { hash: '#/perfil', label: 'Mi cuenta', group: 'session' },
  { hash: '#/seguridad', label: 'Seguridad', group: 'session' },
  { hash: '#/organizacion', label: 'Organización', group: 'strong' },
  { hash: '#/finanzas', label: 'Finanzas', group: 'strong' },
  { hash: '#/prestatarios', label: 'Prestatarios', group: 'strong' },
  { hash: '#/prestamos', label: 'Préstamos', group: 'strong' },
  { hash: '#/operaciones', label: 'Operaciones', group: 'strong' },
  { hash: '#/pagos', label: 'Pagos', group: 'strong' },
  { hash: '#/cobranza', label: 'Cobranza', group: 'strong' },
  { hash: '#/informes', label: 'Informes', group: 'strong' },
  { hash: '#/obligaciones', label: 'Gastos y obligaciones', group: 'strong' },
  { hash: '#/patrimonio', label: 'Fondos y activos', group: 'strong' },
  { hash: '#/configuracion', label: 'Configuración', group: 'strong' },
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
  if (hash === '#/inicio') return <HomeScreen />;
  if (hash === '#/configuracion') return <SettingsScreen />;
  if (hash === '#/seguridad') return <SecurityScreen />;
  if (hash === '#/organizacion') return <OrganizationScreen />;
  if (hash === '#/finanzas') return <FinanceScreen />;
  if (hash === '#/prestatarios') return <BorrowersScreen />;
  if (hash === '#/prestamos') return <LoansScreen />;
  if (hash === '#/operaciones') return <OperationsScreen />;
  if (hash === '#/pagos') return <PaymentsScreen />;
  if (hash === '#/cobranza') return <CollectionsScreen />;
  if (hash === '#/informes') return <ReportingScreen />;
  if (hash === '#/obligaciones') return <ObligationsScreen />;
  if (hash === '#/patrimonio') return <WealthScreen />;
  if (hash === '#/perfil') return <ProfileScreen />;
  if (hash === '#/activar' || hash === '#/rechazar') return <ActivateScreen />;
  return <AccessScreen route={hash} />;
}
