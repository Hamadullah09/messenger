# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspaces --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_MEDIA_ORIGIN
# Rewrites are resolved at build time: the API origin as seen from the web container.
ARG API_ORIGIN=http://api:4000
ENV NEXT_PUBLIC_REALTIME_URL=${NEXT_PUBLIC_REALTIME_URL} NEXT_PUBLIC_MEDIA_ORIGIN=${NEXT_PUBLIC_MEDIA_ORIGIN} \
    API_ORIGIN=${API_ORIGIN} NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @storeline/shared && npm run build -w @storeline/web \
 && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /app/apps/web/package.json apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/next.config.ts apps/web/next.config.ts
COPY --from=build --chown=node:node /app/apps/web/.next apps/web/.next
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "--port", "3000"]
