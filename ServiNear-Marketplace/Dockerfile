FROM node:22-bookworm-slim

ENV NODE_ENV=production PORT=10000 DATA_DIR=/app/data
WORKDIR /app

# Copy package files first for layer caching — npm install only re-runs when deps change
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node package-lock.json* ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

# Ensure writable data directory
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 10000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
