FROM node:22-bookworm-slim

ENV NODE_ENV=production PORT=10000 DATA_DIR=/app/data
WORKDIR /app

# Copy package.json first for layer caching
COPY --chown=node:node package.json ./package.json

# Install production dependencies
RUN npm install --omit=dev

# Copy application files
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public

# Ensure data directory exists and is owned by node user
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 10000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
