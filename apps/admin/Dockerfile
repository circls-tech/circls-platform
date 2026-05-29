# Build from the monorepo root, not from apps/admin:
#   docker build -f apps/admin/Dockerfile -t circls-admin .
# Coolify: build pack = Dockerfile · base directory = repo root · Dockerfile = apps/admin/Dockerfile · port 3002.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/admin/package.json apps/admin/package.json
RUN pnpm install --frozen-lockfile --prod=false --filter @circls/admin...

FROM deps AS build
COPY apps/admin ./apps/admin
RUN pnpm --filter @circls/admin build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
WORKDIR /repo

COPY --from=build /repo/apps/admin/.next/standalone ./
COPY --from=build /repo/apps/admin/.next/static ./apps/admin/.next/static

USER node
EXPOSE 3002
CMD ["node", "apps/admin/server.js"]
