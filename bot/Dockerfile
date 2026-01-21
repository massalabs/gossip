# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root package files for workspace setup
COPY package.json package-lock.json ./

# Copy workspace packages
COPY gossip-sdk ./gossip-sdk
COPY bot ./bot

# Install all dependencies
RUN npm ci

# Production stage
FROM node:22-alpine

WORKDIR /app

# Copy node_modules and source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/gossip-sdk ./gossip-sdk
COPY --from=builder /app/bot ./bot
COPY --from=builder /app/package.json ./package.json

WORKDIR /app/bot

# Default environment variables
ENV NODE_ENV=production
ENV AI_PROVIDER=ollama
ENV OLLAMA_URL=http://ollama:11434
ENV OLLAMA_MODEL=llama3.2
ENV PROTOCOL_URL=https://api.usegossip.com
ENV POLLING_INTERVAL_MS=5000

# Run the bot
CMD ["npx", "tsx", "src/index.ts"]
