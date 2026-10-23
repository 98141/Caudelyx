import { runInstalled } from '../servidor/scripts/installed-dev.mjs';

try {
  await runInstalled();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'No se pudo iniciar el perfil local S02.');
  process.exitCode = 1;
}
