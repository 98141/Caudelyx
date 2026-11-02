/* eslint-disable security/detect-object-injection -- Controlled numeric Buffer offsets in corruption tests. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createDecipheriv } from 'node:crypto';
import { BSON } from 'mongodb';
import { component, digest, sealContainer, openContainer, safeRelative, strictDocument } from '../../src/modules/local-recovery/container.js';
import { backupLimits } from '../../src/modules/local-recovery/models.js';
function example() {
    const data = Buffer.from(BSON.EJSON.stringify({ decimal: BSON.Decimal128.fromString('100.01'), date: new Date('2026-11-01T12:00:00Z'), binary: Buffer.from('SYNTHETIC') }, { relaxed: false }));
    const config = component('CONFIGURATION', 'config/configuration.json', Buffer.from('{}'));
    return { formatVersion: 1, runId: randomUUID(), source: { databaseNames: ['caudelyx_s08_p02_' + 'a'.repeat(24), 'caudelyx_s08_p02_' + 'a'.repeat(24) + '_external_mail', 'caudelyx_s08_p02_' + 'a'.repeat(24) + '_external_security'] }, destination: { databaseNames: ['caudelyx_s08_p02_' + 'b'.repeat(24), 'caudelyx_s08_p02_' + 'b'.repeat(24) + '_external_mail', 'caudelyx_s08_p02_' + 'b'.repeat(24) + '_external_security'] }, cut: { economicAsOf: '2026-11-01', capturedAtUTC: '2026-11-01T12:00:00Z', T0: 0, T1: 0, securitySignatureAtT0: '', securitySignatureAtT1: '' }, candidate: { id: 'SYNTHETIC', manifestSHA256: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), contractsSHA256: 'c'.repeat(64), configurationSHA256: config.sha256, keyPolicyVersion: 2 }, components: [component('SIGNED_PRINCIPAL_SNAPSHOT', 'snapshot/principal.ejson', data), component('EXTERNAL_MAIL_DATA', 'external/mail.ejson', Buffer.from('[]')), component('EXTERNAL_SECURITY_DATA', 'external/security.ejson', Buffer.from('[]')), component('EXTERNAL_JOURNAL', 'controls/gate.json.journal.jsonl', Buffer.alloc(0)), component('EXTERNAL_CONTROL', 'controls/gate.json', Buffer.from('{}')), component('PRODUCT_KEYRING', 'keys/product.json', Buffer.from('{}')), config] };
}
test('approved envelope independently decrypts with authenticated exact AAD and preserves BSON payload', () => {
    const input = example(), sealed = sealContainer(input), n = sealed.bytes.readUInt32BE(20), end = 24 + n, header = JSON.parse(sealed.bytes.subarray(24, end).toString());
    assert.equal(header.ciphertextBytes, sealed.bytes.length - end - 16);
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(sealed.key.keyBase64, 'base64'), Buffer.from(header.iv, 'base64url'));
    decipher.setAAD(sealed.bytes.subarray(0, end));
    decipher.setAuthTag(sealed.bytes.subarray(-16));
    const clear = Buffer.concat([decipher.update(sealed.bytes.subarray(end, -16)), decipher.final()]);
    assert.equal(digest(clear), digest(JSON.stringify(input)));
    assert.equal(openContainer(sealed.bytes, sealed.key).components[0].sha256, input.components[0].sha256);
    const recovered = BSON.EJSON.parse(Buffer.from(input.components[0].dataBase64, 'base64').toString());
    assert.equal(recovered.decimal.toString(), '100.01');
    assert.equal(recovered.date.toISOString(), '2026-11-01T12:00:00.000Z');
    const second = sealContainer(input);
    assert.ok(second.key.keyId !== sealed.key.keyId);
    assert.ok(second.key.keyBase64 !== sealed.key.keyBase64);
    assert.ok(!second.bytes.equals(sealed.bytes));
});
test('cipher/key/header/tag/truncation/extra bytes fail before any plaintext is accepted', () => {
    const sealed = sealContainer(example());
    for (const offset of [0, 21, 25, sealed.bytes.length - 17, sealed.bytes.length - 1]) {
        const bytes = Buffer.from(sealed.bytes);
        bytes[offset] = bytes[offset] ^ 1;
        assert.throws(() => openContainer(bytes, { ...sealed.key, containerSHA256: digest(bytes) }));
    }
    for (const bytes of [sealed.bytes.subarray(0, -1), Buffer.concat([sealed.bytes, Buffer.from('x')])])
        assert.throws(() => openContainer(bytes, { ...sealed.key, containerSHA256: digest(bytes) }));
    assert.throws(() => openContainer(sealed.bytes, { ...sealed.key, keyBase64: Buffer.alloc(32, 1).toString('base64') }));
    assert.throws(() => openContainer(sealed.bytes, { ...sealed.key, keyId: randomUUID() }));
});
test('closed catalogs, duplicate IDs/case aliases/missing components/hash/size/cuts cannot be hidden by a valid envelope', () => {
    const original = example();
    const mutate = [(p) => { p.components.pop(); }, (p) => { p.components.push(structuredClone(p.components[0])); }, (p) => { p.components[0].bytes++; }, (p) => { p.components[0].sha256 = '0'.repeat(64); }, (p) => { p.components[0].bytes = backupLimits.component + 1; }, (p) => { p.cut.T0 = 2; }, (p) => { p.destination.databaseNames = [...p.source.databaseNames]; }, (p) => { p.components[0].relativePath = '../escape'; }, (p) => { p.components[0].relativePath = 'SNAPSHOT/PRINCIPAL.EJSON'; }];
    for (const f of mutate) {
        const p = structuredClone(original);
        f(p);
        assert.throws(() => sealContainer(p));
    }
});
test('strict JSON and local path grammar reject duplicate/escaped keys, nesting and Windows aliases without parsing executable content', () => {
    for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', Array(66).fill('[').join('') + '0' + Array(66).fill(']').join(''), '{}x', '{"a":NaN}'])
        assert.throws(() => strictDocument(Buffer.from(text)));
    assert.throws(() => strictDocument(Buffer.from([0xff])));
    assert.deepEqual(strictDocument(Buffer.from('{"ok":[1,true,null]}')), { ok: [1, true, null] });
    for (const p of ['../x', '/absolute', 'C:/key', 'file:ads', 'x\\y', 'a//b', 'a/./b', 'a/../b', 'NUL.txt', 'COM1', 'name.', 'SHORT~1/x', 'a/b '])
        assert.throws(() => safeRelative(p));
    assert.equal(safeRelative('private/11111111-1111-4111-8111-111111111111'), 'private/11111111-1111-4111-8111-111111111111');
    const abort = new AbortController();
    abort.abort();
    assert.throws(() => sealContainer(example(), abort.signal));
});
//# sourceMappingURL=container.test.js.map