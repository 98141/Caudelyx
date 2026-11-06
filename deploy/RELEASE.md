# Caudelyx f06-integral-v2-rc1 — release de demostración privada

Preparación de fuentes para validación Linux posterior. No es una aprobación de producción ni de GATE03. El perfil sigue siendo exclusivamente sintético. No ejecutar este procedimiento hasta autorizar el despliegue y disponer de revisión independiente. La versión instalada de Coolify, los builds Linux, aislamiento y recuperación Docker todavía necesitan ejecución.

## Contenido de la release

Usar el ZIP seleccionado y su SHA256, no un archivo de todo el repositorio. `release-manifest.json` identifica el commit, blobs y SHA256; `SHA256SUMS` permite comprobar sus archivos. Excluye dist, caches, tests, dependencias instaladas, runtime, datos, contratos privados, credenciales y material criptográfico. Los Dockerfiles reconstruyen los servicios desde fuentes/locks. Índices OCI fijados en `deploy/demo.env.example`; el ZIP es determinista, sin promesa de imágenes bit a bit idénticas (apt y servicios externos intervienen en el build).

## Material privado separado

Para una instalación NUEVA, el operador aprovisiona desde el puesto confiable con la documentación privada disponible y Node24/OpenSSL. Usar `provision.mjs --new` exclusivamente con destino inexistente; no se usa para recuperar ni migrar datos. Conservar la salida con deploymentId y digest real del manifiesto de contratos.

Transferir mediante SCP/SFTP sobre SSH con huella del host verificada fuera de banda y `StrictHostKeyChecking=yes`: `profile.json`, `deployment.json`, `control/keys.json`, `secrets/`, `tls/` y `contracts/`. Crear `control/private/` vacío. No transferir `.authority/` (clave CA), local.env, gates/journals, Mongo, respaldos o directorios completos del puesto. Generar/verificar una lista SHA256 del conjunto permitido, también por canal privado. No enviar contraseñas como argumentos ni por Git, chat o logs. Las hojas TLS duran14d y la CA30d: verificar vigencia antes del traslado. Una instalación existente requiere la recuperación del grupo completo, no claves nuevas.

El administrador prepara la raíz privada NUEVA `/opt/caudelyx-private/demo-v2`, con padre/root0700 y dueño root, sin symlinks, fuera del código. El canal de recepción debe ser privado desde antes de escribir. Verificar `sha256sum -c transfer.sha256` dentro de esa raíz y borrar únicamente los duplicados de recepción propios cuando termine la aceptación; no borrar evidencia o volúmenes.

Crear fuera de Git `/opt/caudelyx-private/compose.env` desde `deploy/demo.env.example`, modo0600. Completar raíz privada, digest REAL de `contracts/caudelyx-contracts.json`, release y valores coherentes con el perfil firmado. Mantener proyecto `caudelyx-demo`, bases demo dedicadas, URI interna `mongodb://mongo:27017/?replicaSet=rs0`, hosts/orígenes/authorities de la plantilla y puertos loopback3001/3002. Las contraseñas se leen de archivos. No editar el perfil firmado ni regenerar claves en reinicios. No usar variables owner/dev de pruebas.

## Secuencia Linux — solo cuando se autorice

La red bridge externa local `caudelyx-demo-hostaccess` debe existir ANTES del despliegue. Compose solo la referencia con `external: true`; no la crea ni debe intentarse crear de nuevo con el mismo nombre. Solo web se conecta a ella y a edge; edge/database siguen internas, API pertenece a ambas y Mongo solo a database. No usar la red compartida de Coolify. Si falta la red o su driver/aislamiento no coincide, detenerse y resolver el requisito con el administrador.

Entrar en una sesión de administrador root, dentro de la carpeta `Caudelyx` extraída en un directorio NUEVO. Sustituir rutas si se eligieron otras. Requisitos: Linux x86_64, Docker/Compose v2 locales, Node >=24.15 <25, Python3, OpenSSL, curl, espacio suficiente, conectividad a los registros y permisos de administrador. Node en el host no se presupone instalado por tener Coolify; si falta, parar y preparar ese requisito por el canal del administrador. No instalar ni modificar Coolify como parte de estos comandos.

Antes: verificar SHA256 del ZIP recibido contra el comunicado por el operador, inspeccionar sus rutas y extraer en destino inexistente; desde la raíz extraída que contiene `Caudelyx/`, ejecutar `sha256sum -c SHA256SUMS`. Después entrar en `Caudelyx`. El manifiesto indica el commit exacto; no continuar con otro candidato.

```bash
set -Eeuo pipefail
umask 077
test "$(id -u)" -eq 0
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
node -e 'let [a,b]=process.versions.node.split(".").map(Number);if(a!==24||b<15)process.exit(1)'
docker version --format '{{.Server.Version}}'
docker compose version
command -v python3 >/dev/null
command -v openssl >/dev/null
command -v curl >/dev/null
df -h . /opt
free -m

ENV=/opt/caudelyx-private/compose.env
PRIVATE=/opt/caudelyx-private/demo-v2
COMPOSE=deploy/docker-compose.demo.yml
test -f "$ENV"
test -d "$PRIVATE/control/private"
test ! -L "$ENV"
test ! -L "$PRIVATE"
chmod 600 "$ENV"
test "$(realpath "$PRIVATE")" = "$PRIVATE"
cd "$PRIVATE"
sha256sum -c transfer.sha256
cd - >/dev/null
node deploy/tools/provision.mjs --prepare-linux "$PRIVATE"
node --input-type=module -e 'import{verifyBundle}from"./deploy/api/verify-contracts.mjs";const p=process.argv[1];await verifyBundle(p+"/contracts",p+"/contracts/caudelyx-contracts.json",process.argv[2])' "$PRIVATE" "$(sha256sum "$PRIVATE/contracts/caudelyx-contracts.json" | cut -d' ' -f1)"

dc() { docker compose --env-file "$ENV" -f "$COMPOSE" "$@"; }
test "$(docker network inspect --format '{{.Driver}}/{{.Internal}}/{{.Scope}}' caudelyx-demo-hostaccess)" = 'bridge/false/local'
dc config --quiet
dc config --format json | python3 -c '
import json,sys,pathlib,hashlib
m=json.load(sys.stdin);p=pathlib.Path(sys.argv[1]);profile=json.loads((p/"profile.json").read_text())["payload"];s=m["services"];a=s["api"]["environment"]
assert m["name"]=="caudelyx-demo" and set(s)=={"api","mongo","web"}
assert not s["mongo"].get("ports") and not s["api"].get("ports")
assert set(s["mongo"]["networks"])=={"database"} and set(s["api"]["networks"])=={"database","edge"} and set(s["web"]["networks"])=={"edge","hostaccess"}
assert all(m["networks"][n]["internal"] for n in ["database","edge"])
assert set(m["networks"])=={"database","edge","hostaccess"}
assert m["networks"]["hostaccess"]["external"] is True and m["networks"]["hostaccess"]["name"]=="caudelyx-demo-hostaccess"
assert {(v["host_ip"],str(v["published"]),v["target"]) for v in s["web"]["ports"]}=={("127.0.0.1","3001",3001),("127.0.0.1","3002",3443)}
assert a["MONGODB_DATABASE"]==profile["databaseName"] and a["MONGODB_URI"]==profile["mongoUri"]
assert a["TENANT_ORIGIN"]==profile["tenantOrigin"] and a["PLATFORM_ORIGIN"]==profile["platformOrigin"]
assert a["CAUDELYX_CONTRACTS_SHA256"]==hashlib.sha256((p/"contracts/caudelyx-contracts.json").read_bytes()).hexdigest()
assert pathlib.Path(m["secrets"]["demo_profile"]["file"])==p/"profile.json"
assert s["mongo"]["image"].count("@sha256:")==1
' "$PRIVATE"
test -z "$(dc ps -aq)"  # instalación nueva; si existe, PARAR, no adoptarla
test -z "$(ss -H -ltn '( sport = :3001 or sport = :3002 )')"
node deploy/tools/operations.mjs prepare-volumes --compose "$COMPOSE" --env "$ENV" --private-root "$PRIVATE"
dc build api
dc build web

# Desde aquí solo se detienen web/api de ESTE proyecto ante un error.
# Conservar Mongo y sus volúmenes para diagnóstico; nunca prune/down -v.
trap 'rc=$?; trap - ERR; dc stop web api || true; echo "PARADA: revisar diagnóstico local; no borrar controles/volúmenes" >&2; exit "$rc"' ERR
dc up -d mongo
# Esperar material TLS de entrada antes del bootstrap; aún no será healthy.
for i in {1..30}; do
  if dc exec -T mongo test -r /tmp/caudelyx-mongo/ca.pem; then break; fi
  sleep 2
done
dc exec -T mongo test -r /tmp/caudelyx-mongo/ca.pem
dc exec -T mongo mongosh --quiet --norc --host localhost --tls --tlsCAFile /tmp/caudelyx-mongo/ca.pem --file /opt/caudelyx/init-replica.js
wait_healthy() {
  local service=$1 id state
  for i in {1..90}; do
    id=$(dc ps -q "$service")
    test -n "$id"
    state=$(docker inspect --format '{{.State.Health.Status}}' "$id")
    if test "$state" = healthy; then return 0; fi
    if test "$state" = unhealthy; then return 1; fi
    sleep 2
  done
  return 1
}
wait_healthy mongo
# App secret/TLS/keyring/contratos legibles como UID1000 antes del arranque.
dc run --rm --no-deps --entrypoint node api -e 'const f=require("node:fs");if(process.getuid()!==1000)process.exit(1);for(const p of [process.env.KEYRING_FILE,process.env.DEMO_PROFILE_FILE,process.env.MONGODB_USERNAME_FILE,process.env.MONGODB_PASSWORD_FILE,"/run/tls/ca.pem","/run/tls/key.pem","/srv/caudelyx-contracts.json"])f.accessSync(p,f.constants.R_OK)'
dc run --rm --no-deps --entrypoint /bin/sh web -ec 'test "$(id -u)" = 101; test -r /run/tls/key.pem; test -r /run/tls/ca.pem; command -v curl; command -v envsubst'
dc up -d --no-build api
wait_healthy api
dc up -d --no-build web
wait_healthy web
dc exec -T api node docker/healthcheck.mjs live
dc exec -T api node docker/healthcheck.mjs ready
dc exec -T web nginx -t -c /tmp/nginx.conf
dc exec -T web /bin/sh /opt/caudelyx/healthcheck.sh
test -z "$(docker port "$(dc ps -q mongo)")"
test -z "$(docker port "$(dc ps -q api)")"
curl --fail --silent --show-error --cacert "$PRIVATE/tls/web/ca.pem" https://localhost:3001/ >/dev/null
curl --fail --silent --show-error --cacert "$PRIVATE/tls/web/ca.pem" --resolve platform.localhost:3002:127.0.0.1 https://platform.localhost:3002/ >/dev/null
dc ps
docker stats --no-stream "$(dc ps -q mongo)" "$(dc ps -q api)" "$(dc ps -q web)"
```

**Parada:** cualquier exit distinto de0, timeout, health unhealthy, digest/perfil incorrecto, permisos fallidos, puerto inesperado, OOM o topología/red inesperada impide avanzar. El trap preserva datos y deja web/API detenidos después de un fallo de ejecución. No quitar auth/TLS/MFA, no borrar gate/journal y no regenerar claves. Si el fallo es anterior al trap, la secuencia termina sin iniciar servicios. No ejecutar prepare-volumes de nuevo sobre volúmenes existentes.

Antes de aceptar: inspeccionar redes reales (mongo solo database, web edge+hostaccess, API edge+database; ninguna compartida con Coolify), probar rechazo de acceso Mongo anónimo, registro/login/MFA y roles con correo example.test; recorrido sintético mínimo y reinicio. Salud técnica y ready no acreditan negocio. Validar respaldo/restore Docker a destinos nuevos y rollback antes de usar la demo. Custodiar CA de navegador y no usar curl -k ni desactivar TLS.

## Actualizar únicamente la red de web en una instalación existente

Tras actualizar el checkout de `deploy/demo`, desde la misma raíz y con `ENV` y `COMPOSE` apuntando al env y Compose existentes (mismo proyecto/release e imagen web local), ejecutar:

```bash
set -Eeuo pipefail
test "$(docker network inspect --format '{{.Driver}}/{{.Internal}}/{{.Scope}}' caudelyx-demo-hostaccess)" = 'bridge/false/local'
docker compose --env-file "$ENV" -f "$COMPOSE" config --quiet
docker compose --env-file "$ENV" -f "$COMPOSE" up -d --no-deps --no-build --pull never --force-recreate web
```

Cualquier error detiene el procedimiento. Verificar después salud de web, sus redes edge/caudelyx-demo-hostaccess y acceso por el túnel SSH existente; los puertos siguen publicados solo en127.0.0.1. No repetir bootstrap, prepare-volumes ni la secuencia de instalación nueva; no recrear API/Mongo ni borrar redes/volúmenes. La red externa persiste independientemente de Compose.

## Coolify posterior

No hacer push ni configurar Coolify con este documento. El remoto debe verificarse: el04-11-2026 el repositorio de origen era PÚBLICO. La preparación local no autoriza su publicación. Una vez exista un origen Git autorizado y revisión/despliegue aprobados: Compose, rama/commit exactos, directorio raíz del repositorio, archivo `deploy/docker-compose.demo.yml`, modo **Raw**, sin Domains ni Connect to predefined network, Preserve repository during deployment activado. Archivos privados preparados en el host, volúmenes external con nombres intactos. Confirmar el Compose renderizado y usar builds secuenciales/arranque sin build implícito; bootstrap Mongo debe haberse completado primero. No modificar contenedores originales de Coolify. Ajustar solo tras comprobar las opciones de la versión instalada, según su [documentación Compose](https://coolify.io/docs/applications/builds/docker-compose).
