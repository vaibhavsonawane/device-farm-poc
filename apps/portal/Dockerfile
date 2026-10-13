# DeviceLab portal + reverse proxy (Nginx, TLS). Build from the repo root:
#   docker build -f apps/portal/Dockerfile -t devicelab/portal .
FROM node:20-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/protocol/package.json packages/protocol/
COPY packages/ui/package.json packages/ui/
COPY apps/portal/package.json apps/portal/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @devicelab/portal...
COPY packages packages
COPY apps/portal apps/portal
RUN pnpm --filter @devicelab/portal exec vite build

FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/entrypoint.sh /docker-entrypoint.d/05-devicelab-certs.sh
COPY --from=build /repo/apps/portal/dist /usr/share/nginx/html
RUN chmod +x /docker-entrypoint.d/05-devicelab-certs.sh
EXPOSE 80 443
