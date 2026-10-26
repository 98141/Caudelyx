import { randomUUID } from 'node:crypto';
import { mejProfile, password, type MejFixture } from './profile.ts';

export { mejProfile, password };
export type OwnGroup = Awaited<ReturnType<typeof mejProfile>>;

export async function organizationOf(f: MejFixture, actor: Awaited<ReturnType<MejFixture['actor']>>) {
  const created = await f.runtime.organizations.create(actor.issued.context, { name: 'Organización R2', currency: 'COP', timezone: 'America/Bogota' }, randomUUID());
  const id = (created.data as { organization: { id: string } }).organization.id;
  actor.issued.context.organizationId = id;
  actor.issued.context.roleIds = ['T'];
  return id;
}

export async function accountOf(f: MejFixture, actor: Awaited<ReturnType<MejFixture['actor']>>, org: string, code: string, accountClass: 'ASSET' | 'EQUITY' | 'LIABILITY' | 'INCOME', kind: 'CASH' | 'BANK' | 'GENERAL') {
  const payload = { code, name: 'Cuenta ' + code, accountClass, kind, currency: 'COP' };
  const created = await f.runtime.finance.mutate(actor.issued.context, 'createAccount', org, payload, randomUUID());
  return (created.data as { id: string }).id;
}
