// Owner-approved terminal-only exception. This tool never writes tokens, quotas, proofs or logs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { manualPaths, requireSyntheticMode, validateMongo } from './local-runtime.mjs';

export async function messagesFor(email) {
  requireSyntheticMode();
  if (!/^[\x21-\x7e]+@example\.test$/i.test(email) || email.split('@').length !== 2 || email.length > 254) throw new Error('Only synthetic @example.test addresses allowed');
  if (process.env.MONGODB_URI) validateMongo(process.env.MONGODB_URI);
  const p = manualPaths();
  const link = JSON.parse(await fs.readFile(p.descriptor, 'utf8'));
  const uri = validateMongo(link.mongoUri);
  if (link.mode !== 'local-synthetic' || link.databaseName !== p.database || Number(uri.port) !== p.mongoPort || Number(uri.port) === 27017 || path.resolve(link.keyringFile) !== path.join(p.control, 'keys.json')) throw new Error('Not an owned manual connection');
  const origin = new URL(link.tenantOrigin);
  if (origin.protocol !== 'https:' || !['localhost','127.0.0.1','[::1]'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Only owned local HTTPS activation links allowed');
  // Read-only: never call the key loader which creates a new file when missing.
  const keys = JSON.parse(await fs.readFile(path.join(p.control, 'keys.json'), 'utf8'));
  const key = Buffer.from(keys.mail ?? '', 'base64url'); if (key.length !== 32) throw new Error('Invalid local keyring');
  const unseal = text => { const b = Buffer.from(text, 'base64url'), d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };
  const client = new MongoClient(link.mongoUri, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect(); const db = client.db(link.databaseName), now = Date.now(), items = [];
    const identity = await db.collection('identities').findOne({ email: email.toLowerCase(), realm: 'TENANT' });
    if (identity) for (const m of await db.collection('synthetic_mail').find({ subjectId: identity._id, realm: 'TENANT', delivered: true, expiresAt: { $gt: now } }).toArray()) {
      const proof = await db.collection('email_proofs').findOne({ _id: m.proofHash, consumed: false, expiresAt: { $gt: now }, credentialVersion: identity.credentialVersion });
      if (!proof || (proof.purpose === 'INITIAL_MFA_PROOF' && proof.initialProofEpoch !== identity.initialProofEpoch)) continue;
      if (proof.contextId) {
        const context = await db.collection('contexts').findOne({ _id: proof.contextId, revoked: false, kind: 'L', expiresAt: { $gt: now } });
        if (!context) continue;
      }
      const token = unseal(m.encryptedToken);
      const activation = ['ACTIVATION','INITIAL_MFA_PROOF'].includes(m.purpose);
      const hasRegistration=await db.collection('registration_intents').findOne({realm:'TENANT',email:identity.email,consumed:false,expiresAt:{$gt:new Date(now)}});
      const requiresPasswordSetup = m.purpose === 'ACTIVATION' && !hasRegistration;
      const query = new URLSearchParams({purpose:m.purpose,token,...(requiresPasswordSetup?{legacy:'1'}:{})});
      items.push({ purpose: m.purpose, code: token, expiresAt: new Date(m.expiresAt).toISOString(),
        ...(activation?{activationUrl:origin.origin+'/#/activar?'+query.toString(),requiresPasswordSetup}:{}),
        ...(m.warning ? { warning: m.warning } : {}) });
    }
    for (const n of await db.collection('synthetic_notifications').find({ realm: 'TENANT', kind: 'INVITATION', delivered: true, expiresAt: { $gt: now } }).toArray()) {
      const payload = JSON.parse(unseal(n.encryptedPayload)); if (payload.email !== email.toLowerCase()) continue;
      const invitation = await db.collection('invitations').findOne({ _id: n.subjectId, status: 'PENDING', expiresAt: { $gt: now } });
      if (invitation && payload.token) items.push({ purpose: 'INVITATION', code: payload.token, expiresAt: new Date(invitation.expiresAt).toISOString() });
    }
    return items;
  } finally { await client.close(); }
}
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--email') throw new Error('Usage: npm run mailbox:local -- --email persona@example.test');
  const items = await messagesFor(args[1]);
  process.stdout.write(JSON.stringify({ messages: items }, null, 2) + '\n');
} catch { process.stderr.write('Buzón denegado/no disponible: revisa modo local-synthetic, conexión manual propia y correo @example.test.\n'); process.exitCode = 1; }
