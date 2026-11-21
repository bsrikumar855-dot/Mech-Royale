# Mech Royale bot. Built on linux/amd64 by the scorer (network ON at build, <= 10 min). Everything is pinned.
# Runtime: no network, 1 CPU, 512 MB, read-only rootfs (writable /tmp 64 MB), uid 65534, map at /arena (read-only).
#
# Pinned: node 22.23.5 (Debian bookworm-slim), manifest-list digest verified against Docker Hub 2026-11-21.
# Dependencies are pinned by package-lock.json (npm ci). The runtime image carries ZERO npm dependencies:
# esbuild bundles src/ into one dist/index.js at build time, so nothing is transpiled at runtime (no ts-node/tsx).

FROM --platform=linux/amd64 node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build.mjs

FROM --platform=linux/amd64 node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=384"
WORKDIR /bot
COPY --from=build /src/dist ./dist
USER 65534:65534
ENTRYPOINT ["node", "/bot/dist/index.js"]
