# Build from the monorepo root, not from apps/api:
#   docker build -f apps/api/Dockerfile -t circls-api .
# Coolify: build pack = Dockerfile · base directory = repo root · Dockerfile = apps/api/Dockerfile · port 8080.

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --filter @circls/api...

FROM deps AS build
COPY apps/api ./apps/api
RUN pnpm --filter @circls/api build
RUN pnpm --filter @circls/api deploy --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
