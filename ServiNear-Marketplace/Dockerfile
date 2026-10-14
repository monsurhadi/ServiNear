FROM node:22-bookworm-slim

ENV NODE_ENV=production PORT=5000 DATA_DIR=/app/data
WORKDIR /app

COPY --chown=node:node server.js ./server.js
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 5000
VOLUME ["/app/data"]
CMD ["node", "server.js"]
