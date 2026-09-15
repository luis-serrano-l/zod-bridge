# Build context is the repository root (see docker-compose.yml).

# --- Stage 1: build and pack zod-bridge exactly as it would ship to npm ---
FROM node:22-alpine AS lib
WORKDIR /lib
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY src ./src
RUN npx prisma generate && npm run build && npm pack && mv zod-bridge-*.tgz zod-bridge.tgz

# --- Stage 2: a plain consumer app that installs the packed tarball ---
FROM node:22-alpine AS demo
WORKDIR /app
COPY examples/demo/package.json ./
COPY --from=lib /lib/zod-bridge.tgz /tmp/zod-bridge.tgz
RUN npm install && npm install /tmp/zod-bridge.tgz
COPY examples/demo/prisma ./prisma
COPY examples/demo/prisma.config.ts examples/demo/main.ts ./
RUN npx prisma generate
ENV FORCE_COLOR=1
CMD ["npm", "start", "--silent"]
