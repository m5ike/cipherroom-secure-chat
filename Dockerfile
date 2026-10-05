# Base image: node:24-slim, pinned by its multi-arch index digest (6.12,
# F-29) so a rebuild cannot silently pick up a different image. Resolved
# 2026-10-05 from Docker Hub; to update, resolve the new digest of the tag
# (docker buildx imagetools inspect node:24-slim) and change both FROM lines.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# The build needs the devDependencies (Vite, esbuild, TypeScript); the
# runtime stage below carries no node_modules at all, which is stricter than
# `npm ci --omit=dev`. npm's audit report stays on.
RUN npm ci --no-fund
COPY . .
RUN npm run check && npm run build

# dist/*.cjs inline every server dependency (see script/build.ts) and the
# client libraries are compiled into dist/public, so the runtime image needs
# no node_modules at all (the native SQLCipher / speech modules travel in
# dist/node_modules). Nothing from .env* reaches any layer (.dockerignore).
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/admin-ui ./admin-ui
# 5.1: the built-in speech engine unpacks its models with tar + bzip2.
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 && rm -rf /var/lib/apt/lists/*
# Unprivileged: the image's `node` user (uid 1000); the code stays root-owned and read-only.
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5000) + '/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.cjs"]
