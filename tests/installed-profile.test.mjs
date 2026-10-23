import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installedSettings, validateInstalledUri } from '../servidor/scripts/installed-profile.mjs';
import { messagesFor } from '../servidor/scripts/mailbox-installed.mjs';

test('perfil instalado fija base/servicio y separa controles del manual', () => {
  const p = installedSettings({});
  assert.equal(p.database, 'caudelyx_dev');
  assert.equal(p.mongoUri, 'mongodb://localhost:27017');
  assert.match(p.control, /installed-control$/);
  assert.equal(p.uiPort, 3001);
  assert.equal(p.apiPort, 4001);
  assert.equal(p.platformPort, 3002);
});

test('URI rechaza remoto, credenciales, otro puerto/base y opciones no permitidas', () => {
  for (const uri of ['mongodb+srv://localhost', 'mongodb://example.test:27017', 'mongodb://u:p@localhost:27017',
    'mongodb://localhost:27181', 'mongodb://localhost:27017/otra', 'mongodb://localhost:27017/?directConnection=true',
    'mongodb://localhost:27017/?replicaSet=a&replicaSet=b']) assert.throws(() => validateInstalledUri(uri));
  assert.equal(validateInstalledUri('mongodb://127.0.0.1:27017/?replicaSet=rs0').port, '27017');
});

test('modo/base/puertos inválidos se rechazan antes de conectar', () => {
  for (const env of [{ CAUDELYX_MODE: 'production' }, { MONGODB_DATABASE: 'caudelyx_manual' },
    { MONGODB_DATABASE: 'other' }, { CAUDELYX_DEV_TEST_ID: '../manual' }, { CAUDELYX_DEV_API_PORT: '27017' },
    { CAUDELYX_DEV_API_PORT: '3001' }, { CAUDELYX_DEV_UI_PORT: 'abc' }]) assert.throws(() => installedSettings(env));
});

test('fixture cerrada crea solo nombre de prueba y controles propios', () => {
  const testId = 'a'.repeat(24), p = installedSettings({ CAUDELYX_DEV_TEST_ID: testId });
  assert.equal(p.database, `caudelyx_s02_test_${testId}`);
  assert.ok(p.control.includes('installed-tests'));
  assert.ok((p.database + '_external_security').length <= 63);
  assert.throws(() => installedSettings({ CAUDELYX_DEV_TEST_ID: 'a'.repeat(32) }));
  assert.throws(() => installedSettings({ CAUDELYX_DEV_TEST_ID: testId, MONGODB_DATABASE: 'caudelyx_dev' }));
});

test('buzón exige modo explícito y dominio sintético sin tocar Mongo', async () => {
  const saved = process.env.CAUDELYX_MODE;
  try {
    process.env.CAUDELYX_MODE = 'production';
    await assert.rejects(messagesFor('persona@example.test'), /local-synthetic/);
    delete process.env.CAUDELYX_MODE;
    await assert.rejects(messagesFor('persona@example.test'), /local-synthetic/);
    process.env.CAUDELYX_MODE = 'local-synthetic';
    await assert.rejects(messagesFor('persona@gmail.com'), /synthetic/);
    await assert.rejects(messagesFor('persona@other@example.test'), /synthetic/);
  } finally {
    if (saved === undefined) delete process.env.CAUDELYX_MODE; else process.env.CAUDELYX_MODE = saved;
  }
});
