# F06 — revalidación única de restauración en Linux

Corrección: el helper Docker de extracción necesita `--interactive` para recibir el archivo por stdin. Ahora se comprueban transferencia AES-256-GCM y cierre del proceso; los errores del helper se traducen a códigos cerrados. El formato de respaldo v1, firma/HMAC, hashes, claves y autenticación GCM se conservan. Esto corrige un defecto demostrado en el comando; sin ejecutar el caso original de VM103 no se atribuye toda su causa a una excepción concreta.

Los diagnósticos stderr indican etapa/status/código y rol mongo-data/api-runtime. Por ejemplo: VOLUME_CREATE, VOLUME_TRANSFER, PRIVATE_DECRYPT_EXTRACT o PRIVATE_IDENTITY; ENOSPC/EACCES/EROFS, BACKUP_TRUNCATED, RESTORE_GCM_AUTH_FAILED, RESTORE_HELPER_MOUNT_INVALID, RESTORE_HELPER_IMAGE_UNAVAILABLE o exitCode del helper. No contienen stderr bruto, claves, IV/tag, cabeceras ni contenidos. CAUDELYX_RESTORE_TARGETS registra UUID/nombres NUEVOS; ante fallo CAUDELYX_RESTORE_QUARANTINED conserva esos destinos. Las rutas privadas completas solo aparecen en el resultado normal de éxito, que debe custodiarse localmente.

No se borran ni reutilizan destinos parciales. La extracción puede haber escrito datos ANTES de autenticar el tag final: cualquier fallo invalida TODO el grupo, aunque haya archivos presentes. Solo COMPLETE/OK más exit0 y verificación posterior permiten aceptar la extracción. No arrancar la aplicación como parte de esta revalidación.

Ejecutar una sola vez desde el checkout corregido en VM103, como root, con Node>=24.15<25 y Docker local. Sustituir únicamente BACKUP y KEYFILE por el respaldo cifrado y su clave EXISTENTES; el helper debe ser el digest Node aprobado ya disponible localmente. El siguiente digest corresponde al env público vigente; si la instalación usa otro aprobado, conservar ese valor. No generar claves/certificados ni un respaldo adicional.

```bash
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(uname -s)" = Linux
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a!==24||b<15)process.exit(1)'
node --check deploy/tools/operations.mjs

BACKUP=/ruta-segura/backup-EXISTENTE
KEYFILE=/ruta-segura/backup.key
HELPER_IMAGE='node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d'
test -f "$BACKUP/manifest.json"
test -f "$KEYFILE"
test ! -L "$KEYFILE"
test -d /opt/caudelyx-private
docker image inspect "$HELPER_IMAGE" >/dev/null
RUN=$(cat /proc/sys/kernel/random/uuid)
DEST="/opt/caudelyx-private/restore-$RUN"
LOG="/opt/caudelyx-private/restore-validation-$RUN"
test ! -e "$DEST" && test ! -L "$DEST"
mkdir -m 700 -- "$LOG"

if node deploy/tools/operations.mjs restore \
  --backup "$BACKUP" --private-root "$DEST" \
  --key-file "$KEYFILE" --helper-image "$HELPER_IMAGE" \
  >"$LOG/result.json" 2>"$LOG/diagnostics.log"; then
  node --input-type=module - "$LOG/result.json" "$DEST" "$BACKUP/manifest.json" <<'NODE'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const [resultFile,dest,manifestFile]=process.argv.slice(2);
try {
  const r=JSON.parse(fs.readFileSync(resultFile)),p=JSON.parse(fs.readFileSync(manifestFile)).payload;
  if(r.services!=='NOT_STARTED'||r.privateRoot!==dest||r.sourceBackupId!==p.backupId)throw Error();
  const id=r.project.replace(/^caudelyx-demo-restore-/,'');
  if(!/^[a-f0-9-]{36}$/.test(id)||Object.keys(r.volumes).sort().join(',')!=='api-runtime,mongo-data')throw Error();
  for(const [role,suffix]of [['mongo-data','mongo'],['api-runtime','runtime']]){
    const name=r.volumes[role];
    if(name!==`caudelyx-demo-restore-${id}-${suffix}`||Object.values(p.volumes).includes(name))throw Error();
    const [v]=JSON.parse(execFileSync('docker',['volume','inspect',name],{encoding:'utf8'}));
    if(v.Name!==name||v.Labels?.['caudelyx.deploymentId']!==p.deploymentId)throw Error();
  }
  for(const name of ['profile.json','control/keys.json'])if(!fs.lstatSync(`${dest}/${name}`).isFile())throw Error();
  console.log('RESTORE_GROUP_VERIFIED');
} catch {console.error('RESTORE_REVALIDATION_FAILED');process.exit(1);}
NODE
else
  rc=$?
  cat "$LOG/diagnostics.log" >&2
  echo 'PARADA: conservar respaldo, originales y destinos parciales; no reintentar sobre ellos.' >&2
  exit "$rc"
fi

MONGO_TARGET=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).volumes["mongo-data"])' "$LOG/result.json")
RUNTIME_TARGET=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1])).volumes["api-runtime"])' "$LOG/result.json")
docker run --rm --network none --read-only --user 0:0 \
  --mount "type=volume,source=$MONGO_TARGET,target=/check,readonly" \
  --entrypoint node "$HELPER_IMAGE" -e 'if(!require("node:fs").lstatSync("/check/WiredTiger").isFile())process.exit(1)'
docker run --rm --network none --read-only --user 0:0 \
  --mount "type=volume,source=$RUNTIME_TARGET,target=/check,readonly" \
  --entrypoint node "$HELPER_IMAGE" -e 'for(const p of ["/check/demo-control/gate.json","/check/demo-control/gate.json.journal.jsonl"])if(!require("node:fs").lstatSync(p).isFile())process.exit(1)'
echo 'RESTORE_REVALIDATION_OK: extracción autenticada y copias verificadas; aplicación sin iniciar.'
```

Cualquier error, incluso posterior al restore, exige PARAR y conservar ambos volúmenes nuevos, DEST y LOG en cuarentena. No ejecutar down -v/prune, borrar volúmenes/claves, repetir sobre el mismo destino o regenerar material. No arrancar Mongo/API/web ni modificar env/Coolify aquí. El procedimiento solo crea copias nuevas y helpers de vida corta; los originales y el backup se leen o permanecen intactos. Una extracción correcta todavía requiere validación posterior de arranque/integridad de aplicación autorizada por separado; no acredita restauración funcional financiera.

Prueba local reproducible, exclusivamente sintética y sin Docker: `node --test --test-concurrency=1 deploy/tools/operations.test.mjs`. Crea un único árbol temporal propio con marcador, procesos Node y AES-GCM; limpia solo esos fixtures, nunca destinos operativos. La prueba local no equivale a ejecutar el procedimiento Linux anterior ni prueba el respaldo real de502MB.
