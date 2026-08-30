# 1. Build Stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
# ARCH-015: Deterministic builds
RUN npm ci --only=production
COPY . .

# 2. Production Stage
FROM node:22-alpine
WORKDIR /app

# ARCH-016: Non-root container
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

COPY --from=builder --chown=appuser:appgroup /app /app

EXPOSE 5000

# ARCH-011: Multi-worker process manager
CMD ["npx", "pm2-runtime", "start", "ecosystem.config.js"]
