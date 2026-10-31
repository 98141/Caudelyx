import { readFileSync } from 'node:fs';
import https from 'node:https';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// La clave TLS se lee solo en el proceso Node de Vite. No se importa desde src/.
function tenantTls() {
  const directory = process.env.CAUDELYX_DEV_TLS_DIRECTORY ?? resolve(__dirname, '../servidor/.runtime/tls');
  const cert = readFileSync(resolve(directory, 'cert.pem'));
  const key = readFileSync(resolve(directory, 'key.pem'));
  return { cert, key };
}

export default defineConfig(() => {
  const testing = process.env.VITEST === 'true';
  const tls = testing ? undefined : tenantTls();
  return {
    plugins: [react()],
    server: tls ? {
      host: 'localhost',
      port: Number(process.env.CAUDELYX_DEV_UI_PORT ?? '3001'),
      strictPort: true,
      https: { cert: tls.cert, key: tls.key },
      proxy: {
        '/api': {
          target: `https://127.0.0.1:${Number(process.env.CAUDELYX_DEV_API_PORT ?? '4001')}`,
          changeOrigin: false,
          secure: true,
          agent: new https.Agent({ ca: tls.cert, servername: 'localhost' }),
        },
      },
    } : undefined,
  };
});
