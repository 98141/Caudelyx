import { request } from 'node:https';
export interface ApiBody { data?: Record<string, unknown>; error?: { code: string }; requestId?: string }
export class ApiClient {
  readonly cookies = new Map<string, string>();
  csrf = '';
  constructor(readonly port: number, readonly cert: Buffer, readonly host = 'localhost') {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    return await new Promise<{ status: number; body: ApiBody; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: this.port, path, method, ca: this.cert,
        servername: 'localhost', headers: { Host: `${this.host}:${this.port}`, Origin: `https://${this.host}:${this.port}`,
          Cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; '), 'X-CSRF-Token': this.csrf,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          try {
            for (const value of res.headers['set-cookie'] ?? []) {
              const pair = value.split(';')[0]; if (!pair) continue;
              const index = pair.indexOf('='); this.cookies.set(pair.slice(0,index), pair.slice(index+1));
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as ApiBody : {}, headers: res.headers });
          } catch (error) { reject(error); }
        });
      });
      req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
    });
  }
  async refreshCsrf() {
    const result = await this.call('GET', '/api/v1/auth/csrf');
    if (result.status !== 200 || typeof result.body.data?.['csrfToken'] !== 'string') throw new Error('CSRF context unavailable');
    this.csrf = result.body.data['csrfToken']; return result;
  }
}
