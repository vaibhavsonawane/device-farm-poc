# DeviceLab control server. Build from the repo root:
#   docker build -f apps/server/Dockerfile -t devicelab/server .
FROM node:20-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @devicelab/server...
COPY packages/config packages/config
COPY packages/shared-types packages/shared-types
COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN pnpm rebuild argon2 @prisma/engines prisma @prisma/client \
 && pnpm --filter @devicelab/shared-types --filter @devicelab/protocol build \
 && pnpm --filter @devicelab/server build \
 && pnpm --filter @devicelab/server deploy --legacy --prod /out \
 && cp -r apps/server/dist /out/dist \
 && cd /out && npx prisma generate

FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app devicelab \
 && mkdir -p /data && chown devicelab:devicelab /data
WORKDIR /app
COPY --from=build --chown=devicelab:devicelab /out /app
USER devicelab
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Apply pending migrations, then start. Seed once with: docker compose run --rm server node dist/cli/seed.js
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
