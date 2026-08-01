# 🔗 ShareBin

A simple, secure, and blazing fast Pastebin built with **Bun**, **Hono**, **PostgreSQL**, **Redis**, and **Vite**.

## ✨ Features

- **Blazing Fast**: Runs on a self-hosted Bun server.
- **Dynamic ID**: Automatically scales ID length from 2 to 10 characters based on collision.
- **Signed Cookie grace period**: verify once, share freely for 1 hour.
- **Self-hosted Assets**: No external CDN dependencies (FontAwesome, CodeMirror, PrismJS are all local).
- **TypeScript Frontend**: Fully typed with Vite for HMR and optimized builds.
- **Modern UI**: Dark mode support and polished interface.

## 🚀 Deployment (Self-hosted, Docker Compose)

单进程同时服务 API + 静态前端。整个栈(app + postgres + redis)都在 docker compose 里,Caddy 只做 TLS 反代。

### 1. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env: 设置一个强密码 PG_PASSWORD
```

### 2. 启动服务
```bash
docker compose up -d --build
```
首次会构建 app 镜像(包含 `bun run vite build` 产出的 `dist/`),并拉起 postgres + redis。

### 3. 初始化数据库
```bash
docker exec -i sharebin-pg psql -U sharebin -d sharebin < schema.pg.sql
```

### 4. 配置 Caddy 反代
把 `Caddyfile.example` 里的站点块加进你的 Caddy 配置,然后 reload:
```bash
systemctl reload caddy
```
Caddy 会自动给域名签 TLS 证书。

### 更新
```bash
git pull
docker compose up -d --build   # 重新构建镜像 (含前端 dist)
```

## 配置项参考

| Variable | 说明 |
| :--- | :--- |
| `PG_PASSWORD` | PostgreSQL 密码 (compose 用),`.env` 里设 |
| `DATABASE_URL` | PG 连接串,compose 自动注入,通常不用手动设 |
| `REDIS_URL` | Redis 连接串,compose 自动注入 |
| `NODE_ENV` | `production` / `development` |
| `PORT` | app 监听端口 (默认 3000) |

## Project Structure

```
frontend/          # Frontend (Vite + TypeScript)
  src/             #   TS source
  public/          #   Static assets (CSS, favicon)
  index.html       #   Editor entry point
  viewer.html      #   Viewer entry point
  404.html         #   404 entry point
src/               # Backend (Bun + Hono) + 静态服务
dist/              # Build output (gitignored, 打进镜像)
vite.config.ts     # Vite build config
Dockerfile         # 多阶段: build dist + runtime
docker-compose.yml # app + postgres + redis
schema.pg.sql      # PG schema
Caddyfile.example  # Caddy 反代配置
```

## Scripts

| Command | Description |
| :--- | :--- |
| `bun run dev` | API (port 3000) + Vite (port 3001) 同时启动 |
| `bun run dev:api` | Bun API with --watch |
| `bun run dev:web` | Vite dev server with HMR |
| `bun run build` | typecheck + build frontend |
| `bun run start` | 运行 Bun 后端 (生产) |
| `bun run lint` | lint frontend + backend |

## 🛠️ Local Development

```bash
bun install
bun run dev      # API (bun --watch :3000) + web (vite :3001)
```

Vite dev server (3001) 会把 `/api` 代理到 Bun 后端 (3000)。后端需要 PG + Redis,本地可以跑两个 docker 容器然后设 `DATABASE_URL` / `REDIS_URL` 环境变量。

## 📜 License
MIT
