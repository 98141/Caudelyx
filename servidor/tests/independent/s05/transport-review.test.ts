/* eslint-disable security/detect-object-injection -- Own fixed labels/records of this test, never request input. */
// S05-P05-v2 independent transport review (Claude) of H-S4-03/04 over the REAL TLS socket (no client library framing):
// exact UTF-8 byte boundaries for S4/S5 business JSON, scoped A32 wrapper/payload, other auth routes; GET with a body
// framed by Content-Length and by chunked encoding, HEAD, malformed framing and compressed bodies, direct and via an own
// pass-through HTTPS proxy. Raw status/headers/body bytes are recorded; secrets never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:tls';
import { createServer, request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { reviewProfile, receipt } from './review-profile.js';
import { world, type Group } from './review-fixtures.js';

const evidence = (name: string, d: Record<string, unknown>) => console.log(JSON.stringify({ evidence: name, ...d }));
type Raw = { status: number; headers: string; body: string };
/** Send raw HTTP/1.1 bytes over TLS and return status/headers/body as seen on the wire. */
async function raw(port: number, cert: Buffer, head: string, body: Buffer | string = ''): Promise<Raw> {
  const s = connect({ host: '127.0.0.1', port, servername: 'localhost', ca: cert }); await once(s, 'secureConnect');
  const chunks: Buffer[] = []; s.on('data', d => chunks.push(Buffer.from(d)));
  s.write(head); if (body.length) s.write(body);
  await Promise.race([once(s, 'end'), new Promise(r => setTimeout(r, 4000))]); s.destroy();
  const text = Buffer.concat(chunks).toString('latin1'), split = text.indexOf('\r\n\r\n'), headers = split >= 0 ? text.slice(0, split) : text;
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), headers, body: Buffer.from(split >= 0 ? text.slice(split + 4) : '', 'latin1').toString('utf8') };
}
const code = (r: Raw) => { const j = /"code":"([A-Z_]+)"/.exec(r.body); return `${r.status}${j ? ' ' + j[1] : r.body.length ? ' <non-envelope ' + r.body.length + 'B>' : ' <empty>'}`; };
/** A JSON object padded with multibyte characters to EXACTLY n UTF-8 bytes. */
function sized(n: number, base: Record<string, unknown>, field: string): Buffer {
  const empty = Buffer.byteLength(JSON.stringify({ ...base, [field]: '' })), room = n - empty;
  const two = Math.floor(room / 2), one = room - two * 2, s = 'ñ'.repeat(two) + 'a'.repeat(one), b = Buffer.from(JSON.stringify({ ...base, [field]: s }));
  if (b.length !== n) throw Error(`sizing ${b.length} != ${n}`); return b;
}

test('P05-S5-T01 H-S4-03/04 transport over the real TLS socket, direct and through an own proxy', { timeout: 1200000 }, async () => {
  const group: Group = await reviewProfile();
  try {
    const w = await world(group, '2026-10-24T12:00:00-05:00'), A = await w.tenant('TR', '1000000.00'), o: Record<string, unknown> = {};
    const b = await w.borrower(A, 'TR_B'), L = await w.confirmed(A, 'L', b, { principal: '100.00' });
    await w.connect(A); assert.equal((await w.run(A, await w.disburseRequest(A, L))).status, 201);
    const port = A.c.port, cert = A.c.cert, host = `localhost:${port}`, cookie = [...A.c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = (A.c as unknown as { csrf: string }).csrf;
    const post = (path: string, body: Buffer, extra = '') => raw(port, cert, `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nOrigin: https://${host}\r\nCookie: ${cookie}\r\nX-CSRF-Token: ${csrf}\r\nContent-Type: application/json\r\nIdempotency-Key: ${randomUUID()}\r\nContent-Length: ${body.length}\r\n${extra}Connection: close\r\n\r\n`, body);
    const sizes: Record<string, string> = {}, base = `/api/v1/organizations/${A.org}`;
    for (const [label, path, n] of [['S4 borrowers 65536', '/borrowers', 65536], ['S4 borrowers 65537', '/borrowers', 65537], ['S5 preview 65536', '/loan-operation-previews', 65536], ['S5 preview 65537', '/loan-operation-previews', 65537]] as const)
      sizes[label] = code(await post(base + path, sized(n, { borrowerCode: 'TR_X', profile: { displayName: 'x', schemaVersion: 1, extras: {} } }, 'padding')));
    // A32: scoped S5 purpose wrapper 98304/98305 bytes; payload 65537 inside a <=98304 wrapper; non-scoped purpose 16384/16385.
    const a32 = (n: number, purpose: string, payloadBytes?: number) => { const cmd = { organizationId: A.org, idempotencyKey: randomUUID(), payload: payloadBytes ? JSON.parse(sized(payloadBytes, { request: { kind: 'RECEIPT' } }, 'pad').toString()) : { request: { kind: 'RECEIPT' } }, expectedETag: '"x"' };
      return payloadBytes ? Buffer.from(JSON.stringify({ password: 'x'.repeat(20), purpose, command: cmd, resourceId: b })) : sized(n, { password: 'x'.repeat(20), purpose, command: cmd, resourceId: b }, 'pad'); };
    for (const [label, body] of [['A32 scoped wrapper 98304', a32(98304, 'LOAN_RECEIPT_POST')], ['A32 scoped wrapper 98305', a32(98305, 'LOAN_RECEIPT_POST')], ['A32 scoped payload 65537 (wrapper <=98304)', a32(0, 'LOAN_RECEIPT_POST', 65537)],
      ['A32 other purpose 16384', a32(16384, 'PASSWORD_CHANGE')], ['A32 other purpose 16385', a32(16385, 'PASSWORD_CHANGE')]] as const) sizes[label + ` (${body.length}B)`] = code(await post('/api/v1/auth/reauthenticate', body));
    sizes['business gzip Content-Encoding'] = code(await post(base + '/loan-operation-previews', Buffer.from('{}'), 'Content-Encoding: gzip\r\n'));
    sizes['business invalid UTF-8'] = code(await post(base + '/loan-operation-previews', Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])));
    o['body limits'] = sizes;
    // GET with a body: Content-Length, chunked, HEAD, malformed framing — S4 lending GET and S5 operations GET.
    const get = (path: string, framing: 'none' | 'cl' | 'chunked' | 'bad-cl' | 'bad-chunk', method = 'GET') => {
      const h = `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nConnection: close\r\n`;
      if (framing === 'none') return raw(port, cert, h + '\r\n');
      if (framing === 'cl') return raw(port, cert, h + 'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n', '{}');
      if (framing === 'chunked') return raw(port, cert, h + 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n', '2\r\n{}\r\n0\r\n\r\n');
      if (framing === 'bad-cl') return raw(port, cert, h + 'Content-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n', 'zz\r\n');
      return raw(port, cert, h + 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n', 'zz\r\n{}\r\n');
    };
    const frames: Record<string, string> = {};
    for (const [label, path] of [['S4 GET /loans', base + '/loans'], ['S5 GET /loan-operations/book', base + '/loan-operations/book']] as const) {
      for (const f of ['none', 'cl', 'chunked', 'bad-cl', 'bad-chunk'] as const) { const r = await get(path, f); frames[`${label} body=${f}`] = `${code(r)} ct=${/content-type: ([^\r\n]+)/i.exec(r.headers)?.[1] ?? 'none'}`; }
      const hd = await get(path, 'none', 'HEAD'); frames[`${label} HEAD`] = `${hd.status} bodyBytes=${Buffer.byteLength(hd.body)}`;
    }
    o['GET framing direct'] = frames;
    // Own pass-through HTTPS proxy (Vite-like): forwards method/headers/body bytes as received.
    const proxyServer = createServer({ key: (await import('node:fs')).readFileSync(group.folder + '/tls/key.pem'), cert }, (req, res) => {
      const up = httpsRequest({ host: '127.0.0.1', port, servername: 'localhost', ca: cert, method: req.method, path: req.url, headers: { ...req.headers, host } }, u => { res.writeHead(u.statusCode ?? 502, u.headers); u.pipe(res); }); up.on('error', () => { res.statusCode = 502; res.end(); }); req.pipe(up);
    });
    await receipt({ event: 'proxy-reserved-before-listen', port: 5392 }); proxyServer.listen(5392, '127.0.0.1'); await once(proxyServer, 'listening'); await receipt({ event: 'proxy-created', port: 5392 });
    try {
      const viaProxy: Record<string, string> = {};
      for (const f of ['cl', 'chunked'] as const) { const r = await raw(5392, cert, `GET ${base}/loan-operations/book HTTP/1.1\r\nHost: localhost:5392\r\nCookie: ${cookie}\r\nConnection: close\r\n` + (f === 'cl' ? 'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n' : 'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n'), f === 'cl' ? '{}' : '2\r\n{}\r\n0\r\n\r\n'); viaProxy[`S5 GET body=${f} via proxy`] = code(r); }
      const r2 = await raw(5392, cert, `GET ${base}/loans HTTP/1.1\r\nHost: localhost:5392\r\nCookie: ${cookie}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n`, '{}'); viaProxy['S4 GET body=cl via proxy'] = code(r2);
      o['GET framing via own proxy'] = viaProxy;
    } finally { await new Promise<void>(r => proxyServer.close(() => r())); await receipt({ event: 'proxy-stopped', port: 5392 }); }
    evidence('P05-S5-T01', { observed: o });
    for (const k of ['S4 borrowers 65537', 'S5 preview 65537']) assert.equal(sizes[k], '413 INPUT_TOO_LARGE', k);
    for (const k of ['S4 borrowers 65536', 'S5 preview 65536']) assert.notEqual(sizes[k], '413 INPUT_TOO_LARGE', k);
    for (const label of ['S4 GET /loans', 'S5 GET /loan-operations/book']) for (const f of ['cl', 'chunked']) assert.match(frames[`${label} body=${f}`]!, /^422 INPUT_INVALID ct=application\/json/, `${label} ${f}`);
  } finally { await group.dispose('end'); }
});
