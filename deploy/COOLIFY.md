# Caudelyx — variante Compose para Coolify v4.6.0

Archivo para Coolify: `deploy/docker-compose.coolify.yml`, rama `main`, desde la raíz del repositorio Caudelyx. Es un Compose completo: seleccionarlo directamente, sin combinarlo como override del Compose demo. `deploy/docker-compose.demo.yml` permanece intacto para la operación anterior.

La variante sustituye exclusivamente la raíz de seis bind mounts privados y ocho archivos de secretos por `/opt/caudelyx-private/demo-v2`. Solo se versionan las rutas, nunca su contenido. Cambiar `CAUDELYX_PRIVATE_ROOT` no cambia estas rutas en la variante. No mover datos ni generar material nuevo para adaptarlos: si la instalación usa otra raíz, detenerse y preparar una variante revisada antes de desplegar.

El [validador de la versión v4.6.0](https://github.com/coollabsio/coolify/blob/v4.6.0/bootstrap/helpers/shared.php#L154) contiene una comprobación de metacaracteres que rechaza interpolaciones en rutas. Usar literales evita ese motivo de rechazo sin alterar ni desactivar el validador. Los nombres de volúmenes externos, imágenes, release y demás variables conservan sus expresiones originales; deben recibir los mismos valores de la instalación existente.

Se conservan Mongo solo en database, API en edge/database y web en edge/hostaccess; edge/database internas y hostaccess externa con nombre `caudelyx-demo-hostaccess`. Solo web publica puertos en127.0.0.1:3001/3002. Volúmenes externos, secretos por archivo, montajes de solo lectura, usuarios, TLS/autenticación, healthchecks y límites permanecen iguales. La fuente relativa `./mongo` se conserva y requiere el checkout persistente del repositorio.

Validación local sin despliegue, con el env EXISTENTE fuera de Git:

```sh
docker compose --env-file "$ENV" -f deploy/docker-compose.coolify.yml config --quiet
```

Comprobaciones pendientes en la instancia Coolify v4.6.0, antes de desplegar:

- Seleccionar este archivo desde la raíz correcta del repositorio, en modo Raw Compose; conservar el checkout durante el despliegue. Verificar que `./mongo` resuelva a `deploy/mongo` y que los contextos/Dockerfiles originales se conserven.
- Confirmar en el Compose generado el MISMO proyecto `caudelyx-demo`, nombres de los dos volúmenes externos actuales e imagen/release. No aceptar renombrado, volúmenes nuevos o prefijos automáticos que adopten otro despliegue.
- Confirmar que la raíz privada, los archivos y sus permisos ya existen en el host de destino. No permitir a Coolify sustituir secretos/certificados o crear directorios sobre rutas de archivo; `create_host_path: false` permanece declarado.
- Verificar que la red externa `caudelyx-demo-hostaccess` existe, que no se agrega la red compartida de Coolify y que no hay Domains/proxy ni publicaciones adicionales. No quitar internal a edge/database.
- Validar aceptación por el parser de esa instancia y conservación de secrets, read_only y bind options. Docker Compose local no ejecuta ese parser ni acredita los permisos o rutas del servidor.
- La instalación activa ya ocupa proyecto/volúmenes/puertos: no iniciar otra aplicación en paralelo ni recrear servicios como parte de esta validación. Cualquier cambio de control a Coolify requiere un despliegue posterior autorizado.

La validación de esta corrección no construye imágenes, inicia/reinicia contenedores ni accede a datos. No repetir provision, bootstrap o prepare-volumes sobre la instalación existente.
