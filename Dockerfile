# ── Builder ──────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Prisma requires OpenSSL.
# Install it explicitly so Prisma's native engine has a deterministic
# runtime/build environment.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Generate Prisma Client
COPY prisma ./prisma
RUN npx prisma generate

# Build application
COPY tsconfig.json ./
COPY src ./src
RUN npm run build


# ── Runtime ──────────────────────────────────────────────────────────

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Prisma requires OpenSSL at runtime as well because
# `prisma migrate deploy` executes inside this stage.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Create an unprivileged application user
RUN groupadd --system agentgate \
    && useradd \
        --system \
        --gid agentgate \
        --no-create-home \
        --shell /usr/sbin/nologin \
        agentgate

# Install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application artifacts
COPY --chown=agentgate:agentgate \
    --from=builder /app/dist ./dist

COPY --chown=agentgate:agentgate \
    --from=builder /app/prisma ./prisma

# Prisma generated client
COPY --chown=agentgate:agentgate \
    --from=builder /app/node_modules/.prisma \
    ./node_modules/.prisma

COPY --chown=agentgate:agentgate \
    --from=builder /app/node_modules/@prisma/client \
    ./node_modules/@prisma/client

# Prisma configuration
COPY --chown=agentgate:agentgate \
    prisma.config.js ./

USER agentgate

EXPOSE 3000

HEALTHCHECK \
    --interval=30s \
    --timeout=5s \
    --start-period=15s \
    --retries=3 \
    CMD node -e "require('node:http').get('http://127.0.0.1:3000/healthcheck', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Database migrations happen at container runtime, when Railway has
# injected AGENTGATE_DATABASE_URL.
#
# Only after migrations succeed does the application start.
ENTRYPOINT ["sh", "-c", "npx prisma migrate deploy && node dist/src/server.js"]