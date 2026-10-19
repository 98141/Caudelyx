import { test, expect } from '@playwright/test';
import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { MongoClient as Client } from '../../../servidor/node_modules/mongodb';
import { registerAndActivate, PASSWORD, currentTotp } from '../e2e/fixtures';

async function initialProof(email: string): Promise<string> {
  const { MongoClient } = createRequire(import.meta.url)('../../../servidor/node_modules/mongodb') as { MongoClient: new (uri: string) => Client };
  const server = resolve('../servidor');
  const link = JSON.parse(await readFile(resolve(server, '.runtime/local-connection.json'), 'utf8')) as { mongoUri: string; databaseName: string; keyringFile: string };
  const keys = JSON.parse(await readFile(resolve(server, link.keyringFile), 'utf8')) as { mail: string };
  const client = new MongoClient(link.mongoUri);
  try {
    await client.connect(); const db = client.db(link.databaseName);
    const subject = await db.collection('identities').findOne({ email, realm: 'TENANT' });
    const mail = await db.collection('synthetic_mail').find({ subjectId: subject?._id, purpose: 'INITIAL_MFA_PROOF' }).sort({ expiresAt: -1 }).limit(1).next();
    if (!mail) throw new Error('Initial proof missing in synthetic channel');
    const value = Buffer.from(String(mail['encryptedToken']), 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', Buffer.from(keys.mail, 'base64url'), value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  } finally { await client.close(); }
}

test('UI real: L retoma INITIAL ligado, aviso A30 exacto, factor pendiente y cierre A31 con códigos efímeros', async ({ page, context }) => {
  const email = `p04_initial_${Date.now()}@example.test`;
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await registerAndActivate(page, email);
  await page.getByRole('navigation').getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await page.goto('/#/ingresar');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verificar correo y crear contraseña' })).toBeVisible();
  await expect(page.getByLabel('Contraseña nueva')).toHaveCount(0);
  await page.getByRole('button', { name: 'Solicitar código de primer factor' }).click();
  await expect(page.getByText('Solicitud recibida. Espera el código')).toBeVisible();
  const initial = await initialProof(email);
  await page.getByLabel('Código de activación').fill(initial);
  await page.getByRole('button', { name: 'Activar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Seguridad', exact: true })).toBeVisible();
  await page.getByLabel('Tipo').selectOption('WEBAUTHN');
  await page.getByRole('button', { name: 'Preparar factor', exact: true }).click();
  await expect(page.getByText('Sesión comprobada, sin organización')).toBeVisible();
  const regenerate = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Regenerar códigos de recuperación' }) });
  await regenerate.getByLabel('Contraseña actual', { exact: true }).fill(PASSWORD);
  await regenerate.getByRole('button', { name: 'Regenerar', exact: true }).click();
  // Secrets stay in this test's memory and are never logged or attached.
  await expect(page.locator('output')).toBeVisible();
  const code = (await page.locator('output').textContent())?.split(' ')[0];
  if (!code) throw new Error('Synthetic recovery codes missing');
  await page.getByRole('button', { name: 'Ocultar y borrar de la pantalla' }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await page.goto('/#/ingresar');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByText('El código se consume aunque no completes la recuperación. Si era tu último código y no conservas un factor utilizable, podrías quedar sin acceso; no hay reparación disponible en esta fase', { exact: true })).toBeVisible();
  await page.getByLabel('Código de recuperación', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Iniciar recuperación restringida' }).click();
  await expect(page.getByRole('heading', { name: 'Seguridad', exact: true })).toBeVisible();
  await expect(page.getByText(/Recuperación restringida hasta/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Organización', exact: true })).toHaveCount(0);
  await page.getByLabel('Tipo').selectOption('TOTP');
  await page.getByRole('button', { name: 'Preparar factor', exact: true }).click();
  await expect(page.locator('output')).toBeVisible();
  const secret = new URL((await page.locator('output').textContent()) ?? '').searchParams.get('secret');
  if (!secret) throw new Error('Synthetic provisioning URI missing');
  await page.getByLabel('Código TOTP actual').fill(currentTotp(secret));
  await page.getByRole('button', { name: 'Confirmar TOTP', exact: true }).click();
  await expect(page.getByText('El factor nuevo queda pendiente.')).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Confirmar factor nuevo y retiros' }).click();
  await expect(page.getByText('Recuperación cerrada y sesiones revocadas.')).toBeVisible();
  await expect(page.locator('output')).toBeVisible();
  const me = await page.evaluate(async () => (await fetch('/api/v1/auth/me')).status);
  expect(me).toBe(401);
  await page.goto('/#/ingresar');
  await expect(page.locator('output')).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});
