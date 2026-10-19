import { createDecipheriv, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'synthetic-local-passphrase-01';
const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../../../..');
const serverRoot = resolve(workspace, 'Caudelyx/servidor');
export const evidenceDir = resolve(workspace, 'Construccion/Sprints/S01/Evidencias');

function unseal(value: string, key: Buffer): string {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

function decodeBase32(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replaceAll('=', '').toUpperCase();
  let bits = '';
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export async function freshTotp(secret: string): Promise<string> {
  const usedStep = Math.floor(Date.now() / 1000 / 30);
  let now = Date.now();
  while (Math.floor(now / 1000 / 30) === usedStep) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 400));
    now = Date.now();
  }
  return currentTotp(secret, now);
}

export function currentTotp(secret: string, now = Date.now()): string {
  const counter = Math.floor(now / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

async function connection() {
  const file = JSON.parse(await readFile(resolve(serverRoot, '.runtime/local-connection.json'), 'utf8')) as { mongoUri: string; databaseName: string; keyringFile: string };
  const keys = JSON.parse(await readFile(resolve(serverRoot, file.keyringFile), 'utf8')) as { mail: string };
  return { ...file, mailKey: Buffer.from(keys.mail, 'base64url') };
}

interface MailCursor { sort(order: Record<string, number>): MailCursor; limit(count: number): MailCursor; next(): Promise<Record<string, unknown> | null> }
interface MailCollection { findOne(query: Record<string, unknown>): Promise<Record<string, unknown> | null>; find(query: Record<string, unknown>): MailCursor }
interface MongoClientLike { connect(): Promise<void>; close(): Promise<void>; db(name: string): { collection(name: string): MailCollection } }

export async function readSyntheticToken(kind: 'ACTIVATION' | 'RESET' | 'INVITATION', email: string): Promise<string> {
  const link = await connection();
  const mongo = await import(pathToFileURL(resolve(serverRoot, 'node_modules/mongodb/lib/index.js')).href) as { MongoClient: new (uri: string) => MongoClientLike };
  const client = new mongo.MongoClient(link.mongoUri);
  await client.connect();
  try {
    const db = client.db(link.databaseName);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (kind === 'INVITATION') {
        const notes = db.collection('synthetic_notifications').find({ kind: 'INVITATION' }).sort({ expiresAt: -1 }).limit(5);
        let note = await notes.next();
        while (note) {
          const payload = JSON.parse(unseal(String(note['encryptedPayload']), link.mailKey)) as { email?: string; token?: string };
          if (payload.email === email && payload.token) return payload.token;
          note = await notes.next();
        }
      } else {
        const identity = await db.collection('identities').findOne({ email, realm: 'TENANT' });
        const message = identity ? await db.collection('synthetic_mail').find({ subjectId: identity['_id'], purpose: kind }).sort({ expiresAt: -1 }).limit(1).next() : null;
        if (message?.['encryptedToken']) return unseal(String(message['encryptedToken']), link.mailKey);
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Synthetic ${kind} token was not available`);
  } finally {
    await client.close();
  }
}

export async function registerAndActivate(page: Page, email: string): Promise<void> {
  await page.goto('/#/registro');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Nombre visible').fill('Persona sintetica');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Enviar registro' }).click();
  await expect(page.getByText('no activa la cuenta')).toBeVisible();
  const token = await readSyntheticToken('ACTIVATION', email);
  await page.goto('/#/verificar');
  await page.getByLabel('Código de activación').fill(token);
  await page.getByLabel('Contraseña nueva').fill(PASSWORD);
  await page.getByRole('button', { name: 'Activar' }).click();
  await expect(page.getByRole('heading', { name: 'Seguridad' })).toBeVisible();
}

export async function enrollTotp(page: Page): Promise<string> {
  await page.getByLabel('Etiqueta').fill('Aplicacion sintetica');
  await page.getByRole('button', { name: 'Preparar factor' }).click();
  const uri = await page.locator('output').textContent();
  const secret = new URL(uri ?? '').searchParams.get('secret');
  if (!secret) throw new Error('Provisioning URI did not include a secret');
  await page.getByLabel('Código TOTP actual').fill(currentTotp(secret));
  await page.getByRole('button', { name: 'Confirmar TOTP' }).click();
  await expect(page.getByText('Sesión comprobada, sin organización')).toBeVisible();
  await expect(page.locator('output')).toHaveCount(0);
  return secret;
}
