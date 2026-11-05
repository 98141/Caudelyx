ARG NODE_IMAGE
ARG NGINX_IMAGE
FROM ${NODE_IMAGE} AS build
WORKDIR /build/cliente
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_OPTIONS=--max-old-space-size=768
COPY cliente/package.json cliente/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY cliente/tsconfig.app.json cliente/vite.docker.config.ts cliente/index.html ./
COPY cliente/src ./src
COPY cliente/public ./public
RUN node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
RUN node node_modules/vite/bin/vite.js build --config vite.docker.config.ts

# Pinned Debian nginx-unprivileged image required (see private env template).
FROM ${NGINX_IMAGE} AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/cliente/dist-docker /usr/share/nginx/html
COPY deploy/nginx/nginx.conf /etc/nginx/caudelyx.template
COPY deploy/nginx/start.sh deploy/nginx/healthcheck.sh /opt/caudelyx/
USER 101:101
STOPSIGNAL SIGQUIT
ENTRYPOINT ["/bin/sh", "/opt/caudelyx/start.sh"]
