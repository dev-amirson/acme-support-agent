# syntax=docker/dockerfile:1.7
# One image, one origin: the Node API serves the agent (SSE + WebSocket voice) and the static UI.

# ---- deps: full install (dev deps needed to build) ------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---- build: static UI export + bundled server ----------------------------------------------
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @acme/web && npm run build -w @acme/server

# ---- runtime: production deps for the server only -------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @acme/server --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/out apps/web/out
COPY apps/server/drizzle apps/server/drizzle
COPY knowledge-base knowledge-base

USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/main.js"]
