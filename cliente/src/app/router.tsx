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
import { ExchangeScreen } from '../features/exchange/Exchange';
import { SimulationScreen } from '../features/simulation/Simulation';
import { OrganizationScreen } from '../features/organization/Organization';
import { ActivateScreen, ProfileScreen } from '../features/profile/Profile';
import { SecurityScreen } from '../features/security/Security';
import { SimpleMode } from '../features/simple/SimpleMode';
import type { SimpleScreen } from '../features/simple/types';

const SIMPLE_SCREENS: Record<string, SimpleScreen> = {
  '#/modo-simple/mes': 'mes',
  '#/modo-simple/prestamos': 'prestamos',
  '#/modo-simple/cobros': 'cobros',
  '#/modo-simple/deudas': 'deudas',
  '#/modo-simple/gastos': 'gastos',
  '#/modo-simple/caja': 'caja',
  '#/modo-simple/ahorro': 'ahorro',
};

export const ROUTES = [
  { hash: '#/ingresar', label: 'Ingresar', group: 'public' },
  { hash: '#/registro', label: 'Crear cuenta', group: 'public' },
  { hash: '#/inicio', label: 'Inicio', group: 'session' },
  { hash: '#/modo-simple/mes', label: 'Mi mes', group: 'strong' },
  { hash: '#/modo-simple/prestamos', label: 'Préstamos', group: 'strong', ariaLabel: 'Préstamos, modo simple' },
  { hash: '#/modo-simple/cobros', label: 'Cobros', group: 'strong', ariaLabel: 'Cobros, modo simple' },
  { hash: '#/modo-simple/deudas', label: 'Mis deudas', group: 'strong' },
  { hash: '#/modo-simple/gastos', label: 'Gastos', group: 'strong', ariaLabel: 'Gastos, modo simple' },
  { hash: '#/modo-simple/caja', label: 'Caja y apartados', group: 'strong' },
  { hash: '#/modo-simple/ahorro', label: 'Plan de ahorro', group: 'strong' },
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
  { hash: '#/intercambio', label: 'Importar y exportar', group: 'strong' },
  { hash: '#/simulacion', label: 'Simulación', group: 'strong' },
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
  if (SIMPLE_SCREENS[hash]) return <SimpleMode screen={SIMPLE_SCREENS[hash]} />;
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
  if (hash === '#/intercambio') return <ExchangeScreen />;
  if (hash === '#/simulacion') return <SimulationScreen />;
  if (hash === '#/perfil') return <ProfileScreen />;
  if (hash === '#/activar' || hash === '#/rechazar') return <ActivateScreen />;
  return <AccessScreen route={hash} />;
}
