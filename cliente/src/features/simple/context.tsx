import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { call } from '../../shared/api';
import { useAuth } from '../../shared/auth';
import { ApiError, DiscardedRequest,type SessionMeta } from '../../shared/contracts';
import { todayBogota } from '../../shared/money';
import { createSlot, hasUncertain, keyFor, markUncertain, releaseSlot, resetSlots, simpleGeneration, subscribeSimple } from './memory';
import { concealed, MS_ROOT, cutQuery, msGet } from './transport';
import type { ConsolidatedView, MonthlyView, SimpleScope } from './types';

interface SimpleValue {
  owner: string;
  scope: SimpleScope;
  setScope: (scope: SimpleScope) => void;
  scopes: SimpleScope[];
  bookId: string | null;
  personalState: 'unknown' | 'open' | 'absent' | 'denied';
  openPersonal: () => Promise<void>;
  month: string;
  setMonth: (value: string) => void;
  effectiveDate: string;
  setEffectiveDate: (value: string) => void;
  knownAt: string;
  refreshCut: () => void;
  view: MonthlyView | ConsolidatedView | null;
  viewError: unknown;
  loading: boolean;
  bookEtag: string | null;
  organizationId: string;
  cutSerial: number;
  dropped: boolean;
}

const SimpleContext = createContext<SimpleValue | null>(null);
const personalSlot = createSlot();

export function useSimple(): SimpleValue {
  const value = useContext(SimpleContext);
  if (!value) throw new Error('Modo simple sin contexto.');
  return value;
}

export function SimpleProvider({ owner, children }: { owner: string; children: ReactNode }) {
  const { me,clock,applySession } = useAuth();
  const roles = me?.roleIds ?? [];
  const titular = roles.includes('T') && !roles.includes('SA');
  const organizationId = me?.organizationId ?? '';
  const scopes: SimpleScope[] = [
    ...(organizationId ? ['BUSINESS' as const] : []),
    'PERSONAL',
    ...(titular && organizationId ? ['CONSOLIDATED' as const] : []),
  ];
  const [scope, setScopeState] = useState<SimpleScope>(scopes[0] ?? 'PERSONAL');
  const [personalBook, setPersonalBook] = useState<string | null>(null);
  const [personalState, setPersonalState] = useState<SimpleValue['personalState']>('unknown');
  const [month, setMonth] = useState(() => todayBogota().slice(0, 7));
  const [effectiveDate, setEffectiveDate] = useState(() => todayBogota());
  const [knownAt, setKnownAt] = useState(()=>clock?.meta.serverNow??new Date().toISOString());
  const [cutRevision,setCutRevision]=useState(0);
  const [view, setView] = useState<MonthlyView | ConsolidatedView | null>(null);
  const [viewError, setViewError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [bookEtag, setBookEtag] = useState<string | null>(null);
  const [cutSerial, setCutSerial] = useState(0);
  const [dropped, setDropped] = useState(false);
  const [personalNonce, setPersonalNonce] = useState(0);
  const bookId = scope === 'BUSINESS' ? organizationId || null : scope === 'PERSONAL' ? personalBook : null;

  useEffect(() => subscribeSimple(() => setDropped(true)), []);

  useEffect(() => {
    const lost = hasUncertain();
    resetSlots();
    setCutSerial(value => value + 1);
    if (lost) setDropped(true);
  }, [scope, bookId, month]);

  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    setPersonalState('unknown');
    void (async () => {
      try {
        const result = await call<{ id?: string }>('GET', '/me/personal/book', undefined, { signal: ac.signal });
        if (!live) return;
        const id = String(result.data.id ?? '');
        setPersonalBook(id || null);
        setPersonalState(id ? 'open' : 'absent');
      } catch (error) {
        if (!live || error instanceof DiscardedRequest) return;
        setPersonalBook(null);
        setPersonalState(error instanceof ApiError && error.status === 404 ? 'absent' : 'denied');
      }
    })();
    return () => { live = false; ac.abort(); };
  }, [owner, personalNonce]);

  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    setView(null);
    setBookEtag(null);
    setViewError(null);
    if (scope !== 'CONSOLIDATED' && !bookId) { setLoading(false); return () => { live = false; ac.abort(); }; }
    setLoading(true);
    const query = cutQuery({ month, effectiveDate, knownAt });
    const path = scope === 'CONSOLIDATED' ? `${MS_ROOT}/me/consolidated/monthly?${query}` : `${MS_ROOT}/books/${bookId}/monthly?${query}`;
    void msGet<MonthlyView | ConsolidatedView>(path, ac.signal).then(result => {
      if (!live) return;
      setView(result.data);

      setBookEtag(result.etag);
    }).catch(error => {
      if (!live || error instanceof DiscardedRequest) return;
      setViewError(concealed(error));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; ac.abort(); };
  }, [scope, bookId, month, effectiveDate, knownAt, cutRevision, owner]);

  async function openPersonal() {
    const key = keyFor(personalSlot, 'personal-book');
    try {
      const result = await call<{ id?: string }>('POST', '/me/personal/books', { currency: 'COP' }, { idempotencyKey: key });
      releaseSlot(personalSlot);
      setPersonalBook(String(result.data.id ?? '') || null);
      setPersonalState(result.data.id ? 'open' : 'absent');
      setPersonalNonce(value => value + 1);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 0 || error.status === 503)) markUncertain(personalSlot);
      else releaseSlot(personalSlot);
      throw error;
    }
  }

  function setScope(next: SimpleScope) {
    if (!scopes.includes(next) || next === scope) return;
    setView(null);
    setBookEtag(null);
    setViewError(null);
    setScopeState(next);
  }

  const value: SimpleValue = {
    owner, scope, setScope, scopes, bookId, personalState, openPersonal, month, setMonth, effectiveDate, setEffectiveDate,
    knownAt, refreshCut: () => {void call<{session:SessionMeta}>('POST','/auth/session/activity',{}).then(r=>{applySession(r.data.session);setKnownAt(r.data.session.serverNow);setCutRevision(value=>value+1);}).catch(setViewError);}, view, viewError, loading, bookEtag, organizationId,
    cutSerial, dropped,
  };
  return <SimpleContext.Provider value={value}>{children}</SimpleContext.Provider>;
}

export function useSimpleGeneration(): number {
  const [value, setValue] = useState(simpleGeneration());
  useEffect(() => subscribeSimple(() => setValue(simpleGeneration())), []);
  return value;
}
