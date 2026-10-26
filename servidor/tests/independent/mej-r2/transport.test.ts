import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:https';
import { assertOwnUri } from './profile.ts';

test('MEJ-R2 rechaza perfiles persistentes y ajenos sin conectarse', () => {
  for (const uri of [
    'mongodb://127.0.0.1:27017/?replicaSet=caudelyx-manual',
    'mongodb://127.0.0.1:27181/?replicaSet=caudelyx-manual',
    'mongodb://127.0.0.1:34567/?replicaSet=other',
    'mongodb://10.0.0.8:34567/?replicaSet=caudelyx-manual',
    'mongodb://127.0.0.1:34567/?replicaSet=caudelyx-manual&db=caudelyx_dev',
    'mongodb://127.0.0.1:34567/caudelyx_mej_c1_c1a726f0b18a445baa0d2391?replicaSet=caudelyx-manual',
  ]) assert.throws(() => assertOwnUri(uri), uri);
});

/** Reads status and discards body and Set-Cookie. The caller cookie jar is not updated. */
export function discardEntireResponse(port: number, cert: Buffer, path: string, body: unknown, cookie: string, csrf: string): Promise<{ status: number; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1', port, path, method: 'POST', ca: cert, servername: 'localhost',
      headers: {
        Host: `localhost:${port}`, Origin: `https://localhost:${port}`,
        Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json',
      },
    }, res => {
      const setCookie = res.headers['set-cookie'] ?? [];
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}
