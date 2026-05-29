# Build from the monorepo root, not from apps/consumer:
#   docker build -f apps/consumer/Dockerfile -t circls-consumer .
# Coolify: build pack = Dockerfile · base directory = repo root · Dockerfile = apps/consumer/Dockerfile · port 3003.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/consumer/package.json apps/consumer/package.json
# --prod=false forces devDependencies (typescript, next build tools, etc.) to
# install even if the platform injects NODE_ENV=production at build time.
RUN pnpm install --frozen-lockfile --prod=false --filter @circls/consumer...

FROM deps AS build
COPY apps/consumer ./apps/consumer
RUN pnpm --filter @circls/consumer build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3003
ENV HOSTNAME=0.0.0.0
WORKDIR /repo

# Next.js standalone output for a monorepo preserves the workspace layout:
#   .next/standalone/
#     apps/consumer/server.js          ← entry point
#     apps/consumer/.next/server/      ← server bundles
#     apps/consumer/node_modules/      ← app-scoped runtime deps
#     node_modules/                    ← root-level runtime deps
COPY --from=build /repo/apps/consumer/.next/standalone ./

# Static assets must be copied manually — they are not included in standalone.
COPY --from=build /repo/apps/consumer/.next/static ./apps/consumer/.next/static

# public/ is optional; this app currently has none but guard for the future.
# COPY --from=build /repo/apps/consumer/public ./apps/consumer/public

USER node
EXPOSE 3003
CMD ["node", "apps/consumer/server.js"]
