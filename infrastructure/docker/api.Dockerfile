# syntax=docker/dockerfile:1.7
# One image for both process types: `node dist/main.js` (api) and `node dist/worker.js` (worker).
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Only the api and shared workspaces: the web app's dependencies do not belong in this image.
RUN npm ci --workspace @storeline/api --workspace @storeline/shared --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w @storeline/shared \
 && npm run build -w @storeline/api

# One-shot deployment job (`--target migrate`): applies migrations and syncs the system
# roles. Keeps the Prisma CLI, which the runtime image does not ship.
FROM build AS migrate
WORKDIR /app/apps/api
USER node
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/cli/sync-roles.js"]

FROM build AS prod-deps
RUN npm prune --omit=dev --workspace @storeline/api --workspace @storeline/shared --include-workspace-root \
 && mkdir -p apps/api/node_modules packages/shared/node_modules

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps --chown=node:node /app/node_modules node_modules
# Version-conflicting dependencies are installed next to the workspace, not hoisted.
COPY --from=prod-deps --chown=node:node /app/apps/api/node_modules apps/api/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/shared/package.json packages/shared/package.json
COPY --from=prod-deps --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=prod-deps --chown=node:node /app/apps/api/package.json apps/api/package.json
COPY --from=prod-deps --chown=node:node /app/apps/api/dist apps/api/dist
COPY --from=prod-deps --chown=node:node /app/apps/api/prisma apps/api/prisma
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
