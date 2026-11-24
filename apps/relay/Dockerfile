FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates g++ make python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /repo

COPY . .

RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@omnyo/relay..." --filter omnyo \
  && pnpm --filter @omnyo/relay rebuild better-sqlite3 \
  && pnpm --filter @omnyo/relay run build \
  && pnpm --filter @omnyo/relay deploy --legacy --prod --ignore-scripts /out \
  && cd /out \
  && npm rebuild better-sqlite3

FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

RUN apt-get update \
  && apt-get install -y --no-install-recommends util-linux wget \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

ENV NODE_OPTIONS=--max-semi-space-size=8

WORKDIR /app

COPY --from=build /out /app

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 8443 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=300s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${HEALTH_PORT}/healthz" | grep -qx live

CMD ["sh", "-c", "exec flock -F -n /data/relay.lock node dist/main.js"]
