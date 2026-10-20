import { createDecipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentTotp } from './fixtures';

export const PAGINATION_PASSWORD = 'p04 v2 pagination synthetic passphrase 97531';
const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '../../../servidor');
const origin = 'https://localhost:3001';
const sources = ['127.0.0.6', '127.0.0.7', '127.0.0.8', '127.0.0.9'];

type Cbor = number | string | Buffer | Cbor[] | Map<Cbor, Cbor>;
function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const encoded = Buffer.alloc(3);
  encoded.writeUInt8((major << 5) | 25, 0);
  encoded.writeUInt16BE(value, 1);
  return encoded;
}
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const encoded = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, encoded.length), encoded]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const parts = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

class SoftPasskey {
  private readonly keys: { publicKey: KeyObject; privateKey: KeyObject };
  readonly id = randomBytes(32);
  private counter = 0;
  constructor(private readonly rpId = 'localhost') {
    this.keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  }
  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  registration(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, this.id, cose]);
    return {
      id: this.id.toString('base64url'), rawId: this.id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData('webauthn.create', challenge).toString('base64url'),
        attestationObject: cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url'),
      },
    };
  }
  assertion(challenge: string) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([0x05]), count]);
    const clientData = this.clientData('webauthn.get', challenge);
    return {
      id: this.id.toString('base64url'), rawId: this.id.toString('base64url'), type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), this.keys.privateKey).toString('base64url'),
      },
    };
  }
}

interface Reply { status: number; code: string; data: Record<string, unknown> }
class ApiClient {
  readonly cookies = new Map<string, string>();
  csrf = '';
  constructor(private readonly ca: Buffer, private readonly source: string) {}
  call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolveReply, reject) => {
      const req = request({
        hostname: '127.0.0.1', port: 4001, localAddress: this.source, path: `/api/v1${path}`, method, ca: this.ca, servername: 'localhost', agent: false,
        headers: {
          Host: 'localhost:3001', Origin: origin, Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          'X-CSRF-Token': this.csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra,
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          for (const cookie of response.headers['set-cookie'] ?? []) {
            const pair = cookie.split(';')[0] ?? '';
            const index = pair.indexOf('=');
            if (index > 0) this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsed = raw ? JSON.parse(raw) as { data?: Record<string, unknown>; error?: { code?: string } } : {};
          resolveReply({ status: response.statusCode ?? 0, code: parsed.error?.code ?? '', data: parsed.data ?? {} });
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }
  async refresh(): Promise<void> {
    const result = await this.call('GET', '/auth/csrf');
    if (result.status !== 200 || typeof result.data['csrfToken'] !== 'string') throw new Error(`csrf ${result.status}`);
    this.csrf = result.data['csrfToken'];
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(label);
  return value;
}

function unseal(value: string, key: Buffer): string {
  const bytes = Buffer.from(value, 'base64url');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

async function channel() {
  const link = JSON.parse(await readFile(resolve(serverRoot, '.runtime/local-connection.json'), 'utf8')) as { mongoUri: string; databaseName: string; keyringFile: string };
  const keys = JSON.parse(await readFile(resolve(serverRoot, link.keyringFile), 'utf8')) as { mail: string };
  const mongo = await import(pathToFileURL(resolve(serverRoot, 'node_modules/mongodb/lib/index.js')).href) as { MongoClient: new (uri: string) => { connect(): Promise<void>; close(): Promise<void>; db(name: string): { collection(name: string): { findOne(query: Record<string, unknown>): Promise<Record<string, unknown> | null>; find(query: Record<string, unknown>): { sort(order: Record<string, number>): { limit(count: number): { next(): Promise<Record<string, unknown> | null> } }; toArray(): Promise<Record<string, unknown>[]> } } } } };
  const client = new mongo.MongoClient(link.mongoUri);
  await client.connect();
  const db = client.db(link.databaseName);
  const key = Buffer.from(keys.mail, 'base64url');
  return {
    async mail(email: string): Promise<string> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const subject = await db.collection('identities').findOne({ email, realm: 'TENANT' });
        const row = subject ? await db.collection('synthetic_mail').find({ subjectId: subject['_id'], purpose: 'ACTIVATION' }).sort({ expiresAt: -1 }).limit(1).next() : null;
        if (row) return unseal(String(row['encryptedToken']), key);
        await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
      }
      throw new Error('activation mail missing');
    },
    async invitation(email: string): Promise<string> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        for (const row of await db.collection('synthetic_notifications').find({ kind: 'INVITATION' }).toArray()) {
          const payload = JSON.parse(unseal(String(row['encryptedPayload']), key)) as { email?: string; token?: string };
          if (payload.email === email && payload.token) return payload.token;
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
      }
      throw new Error('invitation missing');
    },
    close: () => client.close(),
  };
}

interface Person { client: ApiClient; key: SoftPasskey; email: string; userId: string }
async function prove(person: Person, purpose: string, resourceId?: string): Promise<void> {
  const target = { purpose, ...(resourceId ? { resourceId } : {}) };
  const options = await person.client.call('POST', '/auth/mfa/webauthn/authentication/options', target);
  if (options.status !== 200) throw new Error(`authentication options ${options.status}`);
  const verified = await person.client.call('POST', '/auth/mfa/challenges/verify', {
    ...target, method: 'WEBAUTHN', ceremonyId: text(options.data['ceremonyId'], 'ceremony'),
    credential: person.key.assertion(text((options.data['publicKey'] as Record<string, unknown>)['challenge'], 'challenge')),
  });
  if (verified.status !== 200) throw new Error(`verify ${verified.status}`);
  await person.client.refresh();
}
async function stepUp(person: Person, purpose: string, resourceId?: string, command?: Record<string, unknown>): Promise<void> {
  const prepared = await person.client.call('POST', '/auth/reauthenticate', { password: PAGINATION_PASSWORD, purpose, ...(resourceId ? { resourceId } : {}), ...(command ? { command } : {}) });
  if (prepared.status !== 200) throw new Error(`reauthenticate ${prepared.status}`);
  await prove(person, purpose, resourceId);
}
async function activate(box: Awaited<ReturnType<typeof channel>>, client: ApiClient, email: string, label: string): Promise<Person> {
  const token = await box.mail(email);
  const confirmed = await client.call('POST', '/auth/email-verifications/confirm', { purpose: 'ACTIVATION', token, newPassword: PAGINATION_PASSWORD });
  if (confirmed.status !== 200) throw new Error(`activation ${confirmed.status}`);
  await client.refresh();
  const key = new SoftPasskey();
  const options = await client.call('POST', '/auth/mfa/webauthn/registration/options', { label });
  if (options.status !== 200) throw new Error(`registration options ${options.status}`);
  const registered = await client.call('POST', '/auth/mfa/webauthn/registration/verify', {
    ceremonyId: text(options.data['ceremonyId'], 'ceremony'),
    credential: key.registration(text((options.data['publicKey'] as Record<string, unknown>)['challenge'], 'challenge')),
  });
  if (registered.status !== 201) throw new Error(`registration ${registered.status} ${registered.code}`);
  await client.refresh();
  const me = await client.call('GET', '/auth/me');
  if (me.status !== 200) throw new Error(`me ${me.status}`);
  return { client, key, email, userId: text(me.data['userId'], 'user') };
}

export interface PagedPopulation { email: string; secret: string; memberOnPageTwo: string; invitationOnPageTwo: string }
export async function populatePagedOrganization(): Promise<PagedPopulation> {
  const ca = await readFile(resolve(serverRoot, '.runtime/tls/cert.pem'));
  const box = await channel();
  try {
    const titularClient = new ApiClient(ca, sources[0] ?? '127.0.0.6');
    await titularClient.refresh();
    const titularEmail = `p04v2_t_${randomUUID()}@example.test`;
    const registered = await titularClient.call('POST', '/auth/register', { email: titularEmail, displayName: 'Titular paginado', privacyPolicyVersion: 'synthetic-v1', acceptTerms: true });
    if (registered.status !== 202) throw new Error(`register ${registered.status}`);
    const titular = await activate(box, titularClient, titularEmail, 'Passkey titular');
    const command = { name: 'Organizacion paginada', timezone: 'America/Bogota', currency: 'COP' };
    await stepUp(titular, 'ORGANIZATION_CREATE', undefined, command);
    const created = await titular.client.call('POST', '/organizations', command, { 'Idempotency-Key': randomUUID() });
    if (created.status !== 201) throw new Error(`organization ${created.status}`);
    await titular.client.refresh();
    const organizationId = text((created.data['organization'] as Record<string, unknown>)['id'], 'organization');
    const people = [titular];
    for (let index = 0; index < 21; index += 1) {
      const email = `p04v2_m${index}_${randomUUID()}@example.test`;
      const invite = { email, roleIds: ['L'] };
      await stepUp(titular, 'MEMBER_INVITE', organizationId, invite);
      const sent = await titular.client.call('POST', '/organization/invitations', invite);
      if (sent.status !== 202) throw new Error(`invite ${sent.status}`);
      if (index === 20) continue;
      const token = await box.invitation(email);
      const guest = new ApiClient(ca, sources[(index % (sources.length - 1)) + 1] ?? '127.0.0.7');
      await guest.refresh();
      const prepared = await guest.call('POST', '/auth/invitations/accept', { mode: 'PREPARE', token, displayName: `Persona ${index}`, privacyPolicyVersion: 'synthetic-v1', acceptTerms: true });
      if (prepared.status !== 202) throw new Error(`prepare ${prepared.status}`);
      const person = await activate(box, guest, email, 'Passkey persona');
      const confirmed = await guest.call('POST', '/auth/invitations/accept', { mode: 'CONFIRM', token });
      if (confirmed.status !== 200) throw new Error(`confirm ${confirmed.status}`);
      await guest.refresh();
      people.push(person);
    }
    const listed = await titular.client.call('GET', '/organization/members?limit=50');
    if (listed.status !== 200) throw new Error(`members ${listed.status}`);
    const items = listed.data['items'] as { userId: string; version: string }[];
    if (items.length !== 21) throw new Error(`member count ${items.length}`);
    const targetId = [...items].map(item => item.userId).sort()[20];
    const target = people.find(person => person.userId === targetId);
    if (!target) throw new Error('page target missing');
    if (target !== titular) {
      const version = items.find(item => item.userId === targetId)?.version;
      if (!version) throw new Error('member version missing');
      const roleChange = { roleIds: ['A'] };
      await stepUp(titular, 'MEMBER_ROLE_CHANGE', targetId, roleChange);
      const changed = await titular.client.call('PATCH', `/organization/members/${targetId}/roles`, roleChange, { 'If-Match': version });
      if (changed.status !== 200) throw new Error(`role ${changed.status}`);
      const rebound = new ApiClient(ca, sources[1] ?? '127.0.0.7');
      await rebound.refresh();
      const login = await rebound.call('POST', '/auth/login', { email: target.email, password: PAGINATION_PASSWORD });
      if (login.status !== 200) throw new Error(`login ${login.status}`);
      await rebound.refresh();
      target.client = rebound;
      await prove(target, 'LOGIN');
    }
    const firstMembers = await titular.client.call('GET', '/organization/members?limit=20');
    const secondMembers = await titular.client.call('GET', `/organization/members?limit=20&cursor=${encodeURIComponent(text(firstMembers.data['nextCursor'], 'member cursor'))}`);
    const firstInvitations = await titular.client.call('GET', '/organization/invitations?limit=20');
    const secondInvitations = await titular.client.call('GET', `/organization/invitations?limit=20&cursor=${encodeURIComponent(text(firstInvitations.data['nextCursor'], 'invitation cursor'))}`);
    const memberOnPageTwo = text(((secondMembers.data['items'] as { displayName: string }[])[0] ?? {})['displayName'], 'page two member');
    const invitationOnPageTwo = text(((secondInvitations.data['items'] as { email: string }[])[0] ?? {})['email'], 'page two invitation');
    const enrollment = { methodType: 'TOTP', label: 'P04 v2' };
    await stepUp(target, 'MFA_ENROLL', undefined, enrollment);
    const enrolled = await target.client.call('POST', '/auth/mfa/totp/enrollments', { label: enrollment.label });
    if (enrolled.status !== 201) throw new Error(`enroll ${enrolled.status}`);
    const secret = new URL(text(enrolled.data['provisioningUri'], 'uri')).searchParams.get('secret');
    if (!secret) throw new Error('totp secret missing');
    const confirmed = await target.client.call('POST', `/auth/mfa/totp/enrollments/${text(enrolled.data['enrollmentId'], 'enrollment')}/confirm`, { code: currentTotp(secret) });
    if (confirmed.status !== 200) throw new Error(`totp confirm ${confirmed.status}`);
    return { email: target.email, secret, memberOnPageTwo, invitationOnPageTwo };
  } finally {
    await box.close();
  }
}
