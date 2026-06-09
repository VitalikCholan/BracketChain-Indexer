# BracketChain Indexer — Phase 1 dev image (devnet, program 3YpkUK).
#
# Single-stage dev image: keeps dev deps so `prisma migrate deploy` (a devDep)
# runs at startup. `nest build` copies src/generated/** (incl. the Prisma
# client) into dist/ via nest-cli.json assets, so `node dist/main` resolves it.
FROM node:24-slim

# Prisma needs OpenSSL for its query engine on debian-slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Install deps first for layer caching.
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare pnpm@10.20.0 --activate \
    && pnpm install --frozen-lockfile

# Build: `prisma generate && nest build` (assets copy generated client to dist).
# prisma.config.ts requires DATABASE_URL to *resolve* at generate-time (it does
# not connect). This placeholder is overridden at runtime by compose's
# `environment: DATABASE_URL`.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY . .
RUN pnpm build

EXPOSE 3001

# `prisma migrate deploy && node dist/main` — DATABASE_URL injected at runtime.
CMD ["pnpm", "start:prod"]
