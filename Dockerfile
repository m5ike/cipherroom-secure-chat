# Syntax: docker buildx (multi-stage)
# Stage 1 — deps + build (devDeps potřebujeme pro tsx/esbuild/vite)
# Stage 2 — runtime (jen prodDeps + built dist)

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000
# OpenSSL pro better-sqlite3 (jinak build selže na alpine, proto bookworm-slim).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# ───────────────────────────── deps ─────────────────────────────
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# ───────────────────────────── build ─────────────────────────────
FROM deps AS build
COPY . .
RUN npm run check && npm run build
RUN npm prune --omit=dev && npm rebuild better-sqlite3

# ───────────────────────────── runtime ─────────────────────────────
FROM base AS runtime
LABEL org.opencontainers.image.title="CipherRoom"
LABEL org.opencontainers.image.description="End-to-end encrypted WebRTC P2P chat. No message persistence. Files up to 2 GB travel encrypted browser-to-browser."
LABEL org.opencontainers.image.source="https://github.com/m5ike/cipherroom-secure-chat"

# healthcheck přes /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5000) + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# data volume pro SQLite (DATABASE_URL=sqlite:./data/events.db)
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 5000
CMD ["node", "dist/index.cjs"]
