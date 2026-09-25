# ─── Production Dockerfile for BYD Sales Floor API ──────────────────────────
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache curl

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=4003

USER node

EXPOSE 4003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4003/api/health || exit 1

CMD ["node", "src/server.js"]

