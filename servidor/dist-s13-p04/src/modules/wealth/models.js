import { cents, storedCents } from '../finance/money.js';
import { AppError } from '../../shared/errors.js';
export const names = ['funds', 'fund_events', 'assets', 'asset_versions', 'asset_events', 'asset_funding', 'asset_valuations', 'asset_flow_links', 'source_claims'];
export const wealthTable = (kind, name) => 's10_' + name + '_' + kind.toLowerCase();
export const wealthOriginals = names.flatMap(name => [wealthTable('BUSINESS', name), wealthTable('PERSONAL', name)]);
export const fields = (c) => ({ bookId: c.scope.bookId, ownerId: c.scope.ownerId, domainKind: c.scope.kind });
export const body = (row) => { const { mac, recordedAt, ...value } = row; void mac; void recordedAt; return value; };
export const data = (value) => value;
export function signedCents(value) { if (value === '-0.00')
    throw new AppError(422, 'INPUT_INVALID'); return value.startsWith('-') ? -cents(value.slice(1)) : cents(value); }
// Per calculation only: repeated identical BSON amounts still use the exact
// established storedCents validator, without repeating Decimal128 formatting.
export function amountReader() { const values = new Map(); return (value) => { const key = Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength).toString('hex'); let amount = values.get(key); if (amount === undefined) {
    amount = storedCents(value);
    values.set(key, amount);
} return amount; }; }
//# sourceMappingURL=models.js.map