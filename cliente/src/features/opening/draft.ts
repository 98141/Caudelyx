import { formatCop, parseLocalCop, parseSignedCop, todayBogota } from '../../shared/money';

export const OPENING_POLICY_VERSION = 'S03-OPENING-0.1';
export const STEPS = [
  ['corte', 'Corte y ámbito'],
  ['soportes', 'Soportes'],
  ['referencias', 'Referencias históricas'],
  ['componentes', 'Componentes y cuentas'],
  ['historicos', 'Interés y antecedentes'],
  ['resumen', 'Resumen y guardado'],
] as const;

export type StepId = (typeof STEPS)[number][0];
export type ReferenceType = 'BORROWER' | 'HISTORICAL_LOAN' | 'OBLIGATION' | 'BASIC_ASSET' | 'BASIC_INVESTMENT';
export type ComponentCategory = 'CASH' | 'BANK' | 'PRINCIPAL_RECEIVABLE' | 'LIABILITY' | 'EQUITY' | 'BASIC_ASSET' | 'BASIC_INVESTMENT';
export type EquityKind = 'CONTRIBUTED' | 'HISTORICAL_RESULTS' | 'OTHER_DECLARED';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Borrador',
  VALIDATED: 'Validado',
  APPROVED: 'Aprobado',
  POSTED: 'Confirmado',
  CANCELLED: 'Cancelado',
};

export const ISSUE_TEXT: Record<string, string> = {
  BALANCE_DIFFERENCE: 'Diferencia de balance',
  LEDGER_DIFFERENCE: 'Diferencia entre débitos y créditos',
  REFERENCE_INVALID: 'Referencia inválida',
  REFERENCE_DUPLICATE: 'Referencia duplicada',
  ACCOUNT_INVALID: 'Cuenta inválida',
  ACCOUNT_MAPPING_INVALID: 'La cuenta no corresponde a la categoría',
  DUPLICATE_POSITION: 'Posición duplicada',
  DATE_INVALID: 'Fecha inválida',
  SUPPORT_REQUIRED: 'Falta un soporte',
  INTEREST_POLICY_INVALID: 'El interés reconocido no queda sustentado',
  LIMIT_EXCEEDED: 'Se superó un límite',
  BOOK_NOT_ELIGIBLE: 'El libro no admite apertura',
  OPENING_ALREADY_POSTED: 'Ya hay una apertura confirmada',
};

export const REFERENCE_LABEL: Record<ReferenceType, string> = {
  BORROWER: 'Contraparte histórica',
  HISTORICAL_LOAN: 'Préstamo histórico',
  OBLIGATION: 'Obligación',
  BASIC_ASSET: 'Activo básico',
  BASIC_INVESTMENT: 'Inversión básica',
};

export const CATEGORY_LABEL: Record<ComponentCategory, string> = {
  CASH: 'Caja',
  BANK: 'Banco',
  PRINCIPAL_RECEIVABLE: 'Principal de cartera histórica',
  LIABILITY: 'Pasivo',
  EQUITY: 'Patrimonio declarado',
  BASIC_ASSET: 'Activo básico',
  BASIC_INVESTMENT: 'Inversión básica',
};

export function newId(): string {
  return crypto.randomUUID();
}

export function presentCop(canonical: string): string {
  const local = formatCop(canonical);
  return local ? `${local} COP (${canonical})` : canonical;
}

export function accountEligibility(category: ComponentCategory | 'RECOGNIZED_INTEREST'): { accountClass: string; kinds: readonly string[] } {
  if (category === 'CASH') return { accountClass: 'ASSET', kinds: ['CASH'] };
  if (category === 'BANK') return { accountClass: 'ASSET', kinds: ['BANK'] };
  if (category === 'LIABILITY') return { accountClass: 'LIABILITY', kinds: ['GENERAL'] };
  if (category === 'EQUITY') return { accountClass: 'EQUITY', kinds: ['GENERAL'] };
  return { accountClass: 'ASSET', kinds: ['GENERAL'] };
}

export interface SupportDraft {
  id: string;
  reference: string;
  asOfDate: string;
  declaration: 'DECLARED' | 'OWNER_CHECKED';
  note: string;
}

export interface ReferenceDraft {
  id: string;
  type: ReferenceType;
  externalReference: string;
  supportIds: string[];
  displayName: string;
  borrowerId: string;
  originationDate: string;
  counterpartyLabel: string;
  incurredDate: string;
  category: string;
  acquisitionDate: string;
  fundingReference: string;
}

export interface ComponentDraft {
  id: string;
  category: ComponentCategory;
  accountId: string;
  amount: string;
  supportIds: string[];
  referenceId: string;
  equityKind: EquityKind | '';
}

export interface InterestDraft {
  id: string;
  loanReferenceId: string;
  amount: string;
  treatment: 'INFORMATIONAL' | 'RECOGNIZED_OPENING';
  supportIds: string[];
  accountId: string;
  recognitionDeclaration: string;
  equityComponentId: string;
}

export interface HistoryDraft {
  id: string;
  date: string;
  description: string;
  supportIds: string[];
  referenceId: string;
}

export interface OpeningDraft {
  cutoffDate: string;
  predecessorId: string;
  changeReason: string;
  supports: SupportDraft[];
  references: ReferenceDraft[];
  components: ComponentDraft[];
  interests: InterestDraft[];
  history: HistoryDraft[];
}

export function emptyDraft(): OpeningDraft {
  return {
    cutoffDate: '', predecessorId: '', changeReason: '',
    supports: [], references: [], components: [], interests: [], history: [],
  };
}

export function emptySupport(): SupportDraft {
  return { id: newId(), reference: '', asOfDate: '', declaration: 'DECLARED', note: '' };
}

export function emptyReference(type: ReferenceType = 'BORROWER'): ReferenceDraft {
  return {
    id: newId(), type, externalReference: '', supportIds: [], displayName: '', borrowerId: '',
    originationDate: '', counterpartyLabel: '', incurredDate: '', category: '', acquisitionDate: '', fundingReference: '',
  };
}

export function emptyComponent(category: ComponentCategory = 'BANK'): ComponentDraft {
  return { id: newId(), category, accountId: '', amount: '', supportIds: [], referenceId: '', equityKind: category === 'EQUITY' ? 'CONTRIBUTED' : '' };
}

export function emptyInterest(): InterestDraft {
  return {
    id: newId(), loanReferenceId: '', amount: '', treatment: 'INFORMATIONAL', supportIds: [],
    accountId: '', recognitionDeclaration: '', equityComponentId: '',
  };
}

export function emptyHistory(): HistoryDraft {
  return { id: newId(), date: '', description: '', supportIds: [], referenceId: '' };
}

function clean(value: string): string {
  return value.trim().normalize('NFC');
}

function dateError(value: string, cutoff: string, label: string): string | null {
  if (!DATE.test(value)) return `${label} necesita una fecha de calendario.`;
  if (value > todayBogota()) return `${label} no puede ser futura.`;
  if (DATE.test(cutoff) && value > cutoff) return `${label} no puede ser posterior al corte.`;
  return null;
}

function supportError(ids: string[], known: Set<string>, label: string): string | null {
  if (ids.length === 0) return `${label} necesita al menos un soporte.`;
  if (ids.some(id => !known.has(id))) return `${label} apunta a un soporte que no está en el expediente.`;
  if (new Set(ids).size !== ids.length) return `${label} repite un soporte.`;
  return null;
}

export interface Snapshot {
  cutoffDate: string;
  supports: unknown[];
  references: unknown[];
  components: unknown[];
  historicalInterest: unknown[];
  informationalHistory: unknown[];
}

export function errorsFor(draft: OpeningDraft, step: StepId | 'all', replacing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const put = (key: string, message: string | null) => { if (message) errors[key] = message; };
  const want = (name: StepId) => step === 'all' || step === name;
  if (want('corte')) {
    put('cutoff', dateError(draft.cutoffDate, draft.cutoffDate, 'La fecha de corte'));
    if (draft.predecessorId && !UUID.test(draft.predecessorId.trim().toLowerCase())) put('predecessorId', 'El antecedente cancelado tiene que ser el identificador del expediente.');
  }
  const knownSupports = new Set(draft.supports.map(item => item.id));
  if (want('soportes') || step === 'all') {
    if (draft.supports.length === 0) put('supports', 'Agrega al menos un soporte.');
    if (draft.supports.length > 100) put('supports', 'Hay más de 100 soportes.');
    for (const support of draft.supports) {
      const reference = clean(support.reference);
      if (!reference || reference.length > 120) put(`support:${support.id}:reference`, 'La referencia del soporte es obligatoria y admite hasta 120 caracteres.');
      put(`support:${support.id}:date`, dateError(support.asOfDate, draft.cutoffDate, 'La fecha del soporte'));
      if (clean(support.note).length > 240) put(`support:${support.id}:note`, 'La nota admite hasta 240 caracteres.');
    }
  }
  if (want('referencias') || step === 'all') {
    if (draft.references.length > 100) put('references', 'Hay más de 100 referencias.');
    const seen = new Set<string>();
    for (const reference of draft.references) {
      const external = clean(reference.externalReference);
      if (!external || external.length > 80) put(`reference:${reference.id}:external`, 'La referencia externa es obligatoria y admite hasta 80 caracteres.');
      const key = `${reference.type}:${external}`;
      if (external && seen.has(key)) put(`reference:${reference.id}:external`, 'Esa referencia externa ya está en este expediente para el mismo tipo.');
      if (external) seen.add(key);
      put(`reference:${reference.id}:support`, supportError(reference.supportIds, knownSupports, 'La referencia'));
      if (clean(reference.fundingReference).length > 120) put(`reference:${reference.id}:funding`, 'El origen informado admite hasta 120 caracteres.');
      if (reference.type === 'BORROWER' && (!clean(reference.displayName) || clean(reference.displayName).length > 80)) put(`reference:${reference.id}:displayName`, 'El nombre visible es obligatorio y admite hasta 80 caracteres.');
      if (reference.type === 'HISTORICAL_LOAN') {
        put(`reference:${reference.id}:date`, dateError(reference.originationDate, draft.cutoffDate, 'La fecha del préstamo histórico'));
        const borrower = draft.references.find(item => item.id === reference.borrowerId);
        if (!borrower || borrower.type !== 'BORROWER') put(`reference:${reference.id}:borrower`, 'El préstamo histórico tiene que apuntar a una contraparte de este expediente.');
      }
      if (reference.type === 'OBLIGATION') {
        if (!clean(reference.counterpartyLabel) || clean(reference.counterpartyLabel).length > 80) put(`reference:${reference.id}:counterparty`, 'La contraparte de la obligación es obligatoria.');
        put(`reference:${reference.id}:date`, dateError(reference.incurredDate, draft.cutoffDate, 'La fecha de la obligación'));
      }
      if (reference.type === 'BASIC_ASSET' || reference.type === 'BASIC_INVESTMENT') {
        if (!clean(reference.category) || clean(reference.category).length > 40) put(`reference:${reference.id}:category`, 'La categoría de la referencia es obligatoria.');
        put(`reference:${reference.id}:date`, dateError(reference.acquisitionDate, draft.cutoffDate, 'La fecha de adquisición'));
      }
    }
  }
  if (want('componentes') || step === 'all') {
    if (draft.components.length === 0) put('components', 'Agrega al menos un componente.');
    if (draft.components.length > 100) put('components', 'Hay más de 100 componentes.');
    for (const component of draft.components) {
      if (!UUID.test(component.accountId)) put(`component:${component.id}:account`, 'Elige una cuenta autorizada.');
      const parsed = component.category === 'EQUITY' ? parseSignedCop(component.amount) : parseLocalCop(component.amount);
      if (!parsed || parsed === '0.00' || parsed === '-0.00') put(`component:${component.id}:amount`, component.category === 'EQUITY'
        ? 'El patrimonio admite un importe distinto de cero, también negativo, con coma decimal.'
        : 'El importe tiene que ser mayor que cero, con punto de miles y coma decimal.');
      put(`component:${component.id}:support`, supportError(component.supportIds, knownSupports, 'El componente'));
      const needsReference = component.category === 'PRINCIPAL_RECEIVABLE' || component.category === 'LIABILITY' || component.category === 'BASIC_ASSET' || component.category === 'BASIC_INVESTMENT';
      if (needsReference) {
        const expected = component.category === 'PRINCIPAL_RECEIVABLE' ? 'HISTORICAL_LOAN' : component.category === 'LIABILITY' ? 'OBLIGATION' : component.category;
        const reference = draft.references.find(item => item.id === component.referenceId);
        if (!reference || reference.type !== expected) put(`component:${component.id}:reference`, 'El componente tiene que apuntar a su referencia histórica.');
      }
      if (component.category === 'EQUITY' && !component.equityKind) put(`component:${component.id}:equity`, 'Indica la clase de patrimonio declarado.');
    }
  }
  if (want('historicos') || step === 'all') {
    if (draft.interests.length > 100) put('interests', 'Hay más de 100 intereses históricos.');
    if (draft.history.length > 100) put('history', 'Hay más de 100 antecedentes.');
    const loans = new Set<string>();
    for (const interest of draft.interests) {
      const loan = draft.references.find(item => item.id === interest.loanReferenceId && item.type === 'HISTORICAL_LOAN');
      if (!loan) put(`interest:${interest.id}:loan`, 'El interés tiene que apuntar a un préstamo histórico de este expediente.');
      if (interest.loanReferenceId && loans.has(interest.loanReferenceId)) put(`interest:${interest.id}:loan`, 'Cada préstamo histórico admite un solo registro de interés.');
      if (interest.loanReferenceId) loans.add(interest.loanReferenceId);
      const amount = parseLocalCop(interest.amount);
      if (!amount || amount === '0.00') put(`interest:${interest.id}:amount`, 'El interés histórico tiene que ser mayor que cero.');
      put(`interest:${interest.id}:support`, supportError(interest.supportIds, knownSupports, 'El interés'));
      if (interest.treatment === 'RECOGNIZED_OPENING') {
        if (!UUID.test(interest.accountId)) put(`interest:${interest.id}:account`, 'El interés reconocido necesita una cuenta de activo distinta.');
        const declaration = clean(interest.recognitionDeclaration);
        if (!declaration || declaration.length > 240) put(`interest:${interest.id}:declaration`, 'La declaración del interés reconocido es obligatoria.');
        const equity = draft.components.find(item => item.id === interest.equityComponentId);
        if (!equity || equity.category !== 'EQUITY' || equity.equityKind !== 'HISTORICAL_RESULTS') put(`interest:${interest.id}:equity`, 'Elige el componente de resultados históricos que sostiene el interés.');
      }
    }
    const knownReferences = new Set(draft.references.map(item => item.id));
    for (const item of draft.history) {
      put(`history:${item.id}:date`, dateError(item.date, draft.cutoffDate, 'La fecha del antecedente'));
      const description = clean(item.description);
      if (!description || description.length > 240) put(`history:${item.id}:description`, 'El antecedente necesita una descripción de hasta 240 caracteres.');
      put(`history:${item.id}:support`, supportError(item.supportIds, knownSupports, 'El antecedente'));
      if (item.referenceId && !knownReferences.has(item.referenceId)) put(`history:${item.id}:reference`, 'El antecedente apunta a una referencia que no está en el expediente.');
    }
  }
  if (step === 'all' && replacing && (!clean(draft.changeReason) || clean(draft.changeReason).length > 240)) {
    put('changeReason', 'Guardar un expediente existente exige el motivo del cambio.');
  }
  return errors;
}

export function snapshotFromDraft(draft: OpeningDraft, replacing: boolean): { snapshot: Snapshot; errors: Record<string, string> } {
  const errors = errorsFor(draft, 'all', replacing);
  const supports = draft.supports.map(support => ({
    id: support.id,
    reference: clean(support.reference),
    asOfDate: support.asOfDate,
    declaration: support.declaration,
    ...(clean(support.note) ? { note: clean(support.note) } : {}),
  }));
  const references = draft.references.map(reference => {
    const shared = {
      id: reference.id,
      type: reference.type,
      externalReference: clean(reference.externalReference),
      supportIds: reference.supportIds,
      ...(clean(reference.fundingReference) ? { fundingReference: clean(reference.fundingReference) } : {}),
    };
    if (reference.type === 'BORROWER') return { ...shared, displayName: clean(reference.displayName) };
    if (reference.type === 'HISTORICAL_LOAN') return { ...shared, borrowerId: reference.borrowerId, originationDate: reference.originationDate };
    if (reference.type === 'OBLIGATION') return { ...shared, counterpartyLabel: clean(reference.counterpartyLabel), incurredDate: reference.incurredDate };
    return { ...shared, category: clean(reference.category), acquisitionDate: reference.acquisitionDate };
  });
  const components = draft.components.map(component => {
    const amount = component.category === 'EQUITY' ? parseSignedCop(component.amount) : parseLocalCop(component.amount);
    const base = { id: component.id, category: component.category, accountId: component.accountId, amount: amount ?? '', supportIds: component.supportIds };
    if (component.category === 'EQUITY') return { ...base, equityKind: component.equityKind };
    if (component.category === 'CASH' || component.category === 'BANK') return base;
    return { ...base, referenceId: component.referenceId };
  });
  const historicalInterest = draft.interests.map(interest => {
    const amount = parseLocalCop(interest.amount) ?? '';
    if (interest.treatment === 'INFORMATIONAL') {
      return { id: interest.id, loanReferenceId: interest.loanReferenceId, amount, treatment: interest.treatment, supportIds: interest.supportIds };
    }
    return {
      id: interest.id, loanReferenceId: interest.loanReferenceId, amount, treatment: interest.treatment, supportIds: interest.supportIds,
      accountId: interest.accountId, recognitionDeclaration: clean(interest.recognitionDeclaration), equityComponentId: interest.equityComponentId,
    };
  });
  const informationalHistory = draft.history.map(item => ({
    id: item.id, date: item.date, description: clean(item.description), supportIds: item.supportIds,
    ...(item.referenceId ? { referenceId: item.referenceId } : {}),
  }));
  const snapshot = { cutoffDate: draft.cutoffDate, supports, references, components, historicalInterest, informationalHistory };
  if (Object.keys(errors).length === 0) {
    const bytes = new TextEncoder().encode(JSON.stringify(replacing
      ? { snapshot, changeReason: clean(draft.changeReason) }
      : { snapshot, ...(draft.predecessorId ? { predecessorId: draft.predecessorId.trim().toLowerCase() } : {}) })).length;
    if (bytes > 65536) errors.size = 'La solicitud supera 64 KiB. No se recorta ni se envía.';
  }
  return { snapshot, errors };
}

function localAmount(canonical: string): string {
  return formatCop(canonical) ?? canonical;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function draftFromSnapshot(snapshot: Snapshot, changeReason = ''): OpeningDraft | null {
  if (!snapshot || !Array.isArray(snapshot.supports) || !Array.isArray(snapshot.references) || !Array.isArray(snapshot.components)) return null;
  const supports = snapshot.supports.map(item => {
    const row = item as SupportDraft;
    return { id: row.id, reference: row.reference ?? '', asOfDate: row.asOfDate ?? '', declaration: row.declaration ?? 'DECLARED', note: row.note ?? '' };
  });
  const references = snapshot.references.map(item => {
    const row = item as ReferenceDraft;
    return { ...emptyReference(row.type), ...row, supportIds: ids(row.supportIds), fundingReference: row.fundingReference ?? '' };
  });
  const components = snapshot.components.map(item => {
    const row = item as ComponentDraft & { amount: string };
    return {
      ...emptyComponent(row.category), ...row, amount: localAmount(row.amount ?? ''), supportIds: ids(row.supportIds),
      referenceId: row.referenceId ?? '', equityKind: row.equityKind ?? '',
    };
  });
  const interests = (Array.isArray(snapshot.historicalInterest) ? snapshot.historicalInterest : []).map(item => {
    const row = item as InterestDraft & { amount: string };
    return { ...emptyInterest(), ...row, amount: localAmount(row.amount ?? ''), supportIds: ids(row.supportIds) };
  });
  const history = (Array.isArray(snapshot.informationalHistory) ? snapshot.informationalHistory : []).map(item => {
    const row = item as HistoryDraft;
    return { ...emptyHistory(), ...row, supportIds: ids(row.supportIds), referenceId: row.referenceId ?? '' };
  });
  return { cutoffDate: snapshot.cutoffDate ?? '', predecessorId: '', changeReason, supports, references, components, interests, history };
}
