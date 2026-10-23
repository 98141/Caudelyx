import { expect, test } from '@playwright/test';

const raw = process.env.AJ_ONB_3_BASE_URL ?? '';
const blockedPorts = new Set(['27017', '27181', '3001', '4001']);

test('AJ-ONB-3 no recorre el servicio del propietario', () => {
  test.skip(raw.length === 0, 'PENDIENTE: no hay AJ_ONB_3_BASE_URL de un perfil temporal propio. No se consulta 3001, 4001, 27017 ni 27181.');
  const url = new URL(raw);
  expect(blockedPorts.has(url.port)).toBe(false);
});
