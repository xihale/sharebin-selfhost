# ShareBin — multi-stage build for self-hosted deployment
# Stage 1: build frontend (dist/) with bun + vite
# Stage 2: runtime serves API + static from one process

# ---------- build stage ----------
FROM oven/bun:1 AS build
WORKDIR /app

# Install deps (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build the frontend → /app/dist
COPY vite.config.ts tsconfig.json ./
COPY frontend ./frontend
COPY src ./src
RUN bun run vite build

# ---------- runtime stage ----------
FROM oven/bun:1 AS runtime
WORKDIR /app

# Production deps only
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source + built static assets
COPY src ./src
COPY tsconfig.json ./
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/index.ts"]
