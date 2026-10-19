
export interface Config {
  mongoUri: string;
  databaseName: string;
  port: number;
  tenantOrigin: string;
  platformOrigin: string;
}
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (env['CAUDELYX_MODE'] !== 'local-synthetic') throw new Error('Local synthetic mode required');
  const mongoUri = env['MONGODB_URI'];
  if (!mongoUri) throw new Error('MONGODB_URI required');
  // No credentials, SRV, remote hosts or silently accepted default topology.
  const parsed = new URL(mongoUri);
  if (parsed.protocol !== 'mongodb:' || parsed.username || parsed.password ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    !parsed.searchParams.get('replicaSet')) throw new Error('Loopback replica set required');
  const databaseName = env['MONGODB_DATABASE'] ?? 'caudelyx_synthetic';
  if (!/^caudelyx_[a-z0-9_]+$/.test(databaseName)) throw new Error('Synthetic database name required');
  const port = Number(env['PORT'] ?? '3001');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const tenantOrigin = env['TENANT_ORIGIN'] ?? 'https://localhost:3001';
  const platformOrigin = env['PLATFORM_ORIGIN'] ?? 'https://platform.localhost:3002';
  const tenant = new URL(tenantOrigin), platform = new URL(platformOrigin);
  for (const url of [tenant, platform]) {
    if (url.protocol !== 'https:' || url.origin !== url.href.replace(/\/$/, '') ||
      !['localhost','platform.localhost'].includes(url.hostname)) {
      throw new Error('Explicit loopback HTTPS origin required');
    }
  }
  if (tenant.hostname === platform.hostname) throw new Error('Platform requires a different host');
  return { mongoUri, databaseName, port, tenantOrigin, platformOrigin };
}
