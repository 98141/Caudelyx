import { describe, expect, it } from 'vitest';
import { draftFromSnapshot, emptyDraft, snapshotFromDraft, type OpeningDraft, type Snapshot } from '../../src/features/opening/draft';

const supportId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const componentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const accountId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const equityId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const equityAccount = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function sample(): OpeningDraft {
  return {
    ...emptyDraft(),
    cutoffDate: '2026-10-22',
    supports: [{ id: supportId, reference: 'SOP-1', asOfDate: '2026-10-22', declaration: 'DECLARED', note: '' }],
    components: [
      { id: componentId, category: 'BANK', accountId, amount: '1.999,50', supportIds: [supportId], referenceId: '', equityKind: '' },
      { id: equityId, category: 'EQUITY', accountId: equityAccount, amount: '-50,00', supportIds: [supportId], referenceId: '', equityKind: 'HISTORICAL_RESULTS' },
    ],
    history: [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', date: '2026-10-01', description: 'Cobro anterior', supportIds: [supportId], referenceId: '' }],
  };
}

describe('borrador de apertura', () => {
  it('arma el payload canónico sin saldo, asiento ni aprobación', () => {
    const { snapshot, errors } = snapshotFromDraft(sample(), false);
    expect(errors).toEqual({});
    expect(snapshot.components).toEqual([
      { id: componentId, category: 'BANK', accountId, amount: '1999.50', supportIds: [supportId] },
      { id: equityId, category: 'EQUITY', accountId: equityAccount, amount: '-50.00', supportIds: [supportId], equityKind: 'HISTORICAL_RESULTS' },
    ]);
    expect(snapshot.informationalHistory).toEqual([
      { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', date: '2026-10-01', description: 'Cobro anterior', supportIds: [supportId] },
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/approved|balance|debit|disbursement/i);
    const body = { snapshot } as Record<string, unknown>;
    expect(body).not.toHaveProperty('approved');
  });

  it('rechaza decimales de más y conserva el texto al reanudar', () => {
    const draft = sample();
    draft.components[0]!.amount = '1.999,509';
    expect(snapshotFromDraft(draft, false).errors[`component:${componentId}:amount`]).toMatch(/formato|mayor que cero/i);
    const stored = snapshotFromDraft(sample(), false).snapshot;
    const resumed = draftFromSnapshot(stored as Snapshot);
    expect(resumed?.components[0]?.amount).toBe('1.999,50');
    expect(resumed?.components[1]?.amount).toBe('-50');
    expect(snapshotFromDraft(resumed!, true).snapshot).toMatchObject({ cutoffDate: '2026-10-22' });
  });
});
