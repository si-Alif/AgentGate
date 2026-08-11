# ── Builder ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system agentgate && useradd --system --gid agentgate --no-create-home --shell /usr/sbin/nologin agentgate

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application artifacts with proper user ownership
COPY --chown=agentgate:agentgate --from=builder /app/dist ./dist
COPY --chown=agentgate:agentgate --from=builder /app/prisma ./prisma
COPY --chown=agentgate:agentgate --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --chown=agentgate:agentgate --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Copy the Prisma Config file
COPY --chown=agentgate:agentgate prisma.config.js ./

USER agentgate
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:3000/healthcheck', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["sh", "-c", "npx prisma migrate deploy && node dist/src/server.js"]