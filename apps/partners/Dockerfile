# Build from the monorepo root, not from apps/partners:
#   docker build -f apps/partners/Dockerfile -t circls-partners .
# Coolify: build pack = Dockerfile · base directory = repo root · Dockerfile = apps/partners/Dockerfile · port 3001.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/partners/package.json apps/partners/package.json
# --prod=false forces devDependencies (typescript, next build tools, etc.) to
# install even if the platform injects NODE_ENV=production at build time.
RUN pnpm install --frozen-lockfile --prod=false --filter @circls/partners...

FROM deps AS build
COPY apps/partners ./apps/partners
RUN pnpm --filter @circls/partners build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
WORKDIR /repo

# Next.js standalone output for a monorepo preserves the workspace layout:
#   .next/standalone/
#     apps/partners/server.js          ← entry point
#     apps/partners/.next/server/      ← server bundles
#     apps/partners/node_modules/      ← app-scoped runtime deps
#     node_modules/                    ← root-level runtime deps
COPY --from=build /repo/apps/partners/.next/standalone ./

# Static assets must be copied manually — they are not included in standalone.
COPY --from=build /repo/apps/partners/.next/static ./apps/partners/.next/static

# public/ is optional; this app currently has none but guard for the future.
# COPY --from=build /repo/apps/partners/public ./apps/partners/public

USER node
EXPOSE 3001
CMD ["node", "apps/partners/server.js"]
