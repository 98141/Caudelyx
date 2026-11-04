import { useAuth } from '../../shared/auth';
import { Empty } from '../../shared/ui';
import { SimpleProvider, useSimpleGeneration, useSimple } from './context';
import { CashScreen } from './Cash';
import { CollectionsScreen } from './Collections';
import { DebtsScreen } from './Debts';
import { ExpensesScreen } from './Expenses';
import { LoansScreen } from './Loans';
import { MonthScreen } from './Month';
import { SavingsScreen } from './Savings';
import type { SimpleScreen } from './types';

export function SimpleMode({ screen }: { screen: SimpleScreen }) {
  const { me, phase } = useAuth();
  const generation = useSimpleGeneration();
  if (phase !== 'ready' || !me?.userId) {
    return <section className="panel simple-wrap"><h1 id="page-title" tabIndex={-1}>Modo simple</h1><Empty>Entra con tu sesión. No se muestran libros de otra persona.</Empty></section>;
  }
  const owner = `${me.userId}|${me.organizationId ?? ''}|${[...(me.roleIds ?? [])].sort().join(',')}|${me.authState}|${generation}`;
  return (
    <SimpleProvider key={owner} owner={owner}>
      <ScopedScreen screen={screen} />
    </SimpleProvider>
  );
}

function ScopedScreen({screen}:{screen:SimpleScreen}){
 const s=useSimple();return <div key={`${s.scope}|${s.bookId??''}|${s.month}|${s.effectiveDate}`}>
 {screen==='mes'?<MonthScreen/>:screen==='prestamos'?<LoansScreen/>:screen==='cobros'?<CollectionsScreen/>:screen==='deudas'?<DebtsScreen/>:screen==='gastos'?<ExpensesScreen/>:screen==='caja'?<CashScreen/>:<SavingsScreen/>}
 </div>;
}
