# Pinned to an exact image digest so every build uses the same base. Dependabot proposes updates.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    NODE_NO_WARNINGS=1

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

# The SQLite database and payment screenshots live in /data (a volume).
# The app itself is read only and runs as the unprivileged "node" user.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "server.js"]
