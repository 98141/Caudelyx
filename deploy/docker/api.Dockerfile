ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build
WORKDIR /build/servidor
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_OPTIONS=--max-old-space-size=768
COPY servidor/package.json servidor/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY servidor/tsconfig.json servidor/tsconfig.local.json ./
COPY servidor/src ./src
RUN node node_modules/typescript/bin/tsc -p tsconfig.local.json --outDir dist-docker
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=768
WORKDIR /srv/Caudelyx/servidor
COPY --from=build --chown=node:node /build/servidor/node_modules ./node_modules
COPY --from=build --chown=node:node /build/servidor/dist-docker ./dist-docker
COPY --chown=node:node servidor/package.json ./package.json
# PDF font is read from this exact source-relative path, even after tsc.
COPY --chown=node:node servidor/src/modules/exchange/assets ./src/modules/exchange/assets
COPY --chown=node:node deploy/tools/mailbox.mjs ./docker-mailbox.mjs
COPY --chown=node:node deploy/api ./docker/
RUN mkdir -p .runtime/demo-control/private && chown node:node .runtime .runtime/demo-control .runtime/demo-control/private
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "docker/entrypoint.mjs"]
