# ShareBin 自托管迁移设计

**日期：** 2026-07-31
**分支：** `migrate-to-selfhost`
**目标：** 把 ShareBin 从 Cloudflare Workers + D1 + KV 迁移到自托管服务器（PostgreSQL + Redis + Docker）。

---

## 1. 背景与动机

当前 ShareBin 完全依赖 Cloudflare 生态：

- **运行时**：Cloudflare Workers（`fetch` + `scheduled` handler）
- **存储**：D1（SQLite 语法）、KV（限流）
- **静态资源**：Workers Assets binding（`ASSETS.fetch`）
- **配置**：`wrangler.jsonc` bindings + secrets
- **验证码**：Cloudflare Turnstile
- **定时任务**：Cron Triggers（`scheduled`）

用户希望迁移到自有服务器，使用**真正的 PostgreSQL 数据库**和 **Redis**，并以 Docker Compose 部署。

### 关键决策（已与用户确认）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 后端语言/运行时 | **TS / Hono + Bun** | 业务逻辑（ID 碰撞重试、过期懒删、签名 cookie、限流）全是纯逻辑，可零改动平移；换语言 ROI 极低 |
| 主数据库 | **PostgreSQL** | 与现有 D1/SQLite 语法最兼容；ID 碰撞重试可改用错误码 `23505` 精准判断，替代脆弱的字符串匹配 |
| Redis 角色 | **限流 + 读缓存** | 顶替 KV 做限流，同时给热点 paste 加读缓存——这是本应用真正的性能杠杆 |
| 部署形态 | **Docker Compose** | 一个 compose 同时起 app + postgres；Redis 复用用户已有容器 |
| 静态资源服务 | **Caddy 直服 + 反代 API** | 静态请求不进应用，吞吐最高；后端砍掉 ASSETS 相关路由 |
| 验证码 | **关闭 Turnstile** | 用户选择；移除整个 captcha 模块，仅靠限流防刷 |
| app/pg 拓扑 | **都进 Docker** | 与现有 redis 同 docker network 内网通信，端口不对宿主机暴露 |

### 性能权衡说明

Pastebin 是 **I/O bound** 应用（每次请求 CPU 实际工作接近零，时间花在等数据库 + 等网络）。语言运行时差异被数据库 I/O 完全淹没，Go/Rust vs Node/Bun 在此场景吞吐差距测不出。真正能拉满性能的杠杆是：**PG 连接池、Redis 读缓存、静态资源由 Caddy 直服**——与本设计选择一致。换语言仅为性能，ROI 接近零。

---

## 2. 架构总览

### 部署拓扑

```
                    Internet
                       │
              ┌────────▼────────┐
              │  Caddy (宿主机)  │  ← 自动 HTTPS，用户已有
              │  直服 dist/ 静态  │
              │  反代 /api/* → app:3000
              └────────┬────────┘
                       │ docker network: sharebin-net
          ┌────────────┼─────────────┐
          │            │             │
   ┌──────▼─────┐ ┌────▼─────┐ ┌─────▼──────┐
   │  app 容器   │ │ pg 容器   │ │ redis 容器  │ ← 现有, external
   │ Bun + Hono │ │postgres:16│ │ (复用用户的) │
   │  API only  │ └──────────┘ └────────────┘
   └────────────┘
```

**职责划分：**
- **Caddy**：TLS 终止、直服 `dist/` 静态资源、`/api/*` 反代到 app 容器。Hono 后端不再处理静态资源。
- **app 容器**：只保留 3 个 API 路由（`POST /api/create`、`GET /api/paste/:id`、`GET /api/config`），跑在 Bun 上。
- **pg 容器**：PostgreSQL 16，数据卷持久化。
- **redis 容器**：复用用户已有容器，承担限流 + 读缓存。

### 数据访问层抽象

不把 PG/Redis 客户端散落各处。引入两个轻量抽象，把业务逻辑和存储解耦：

```
src/db/
  pg.ts        ← PG 连接池 + paste 的 CRUD（替换 D1Database 用法）
  redis.ts     ← Redis 客户端 + 限流原子操作 + 缓存读写
```

这样 `paste.service.ts` 的业务逻辑（ID 碰撞重试、过期判断、懒删除）保持不变，只是它调用的 `db.prepare(...)` 改成调用 `pg.getPaste(id)` 这样的语义方法。

---

## 3. 后端文件级改造

### 3.1 改造清单（按改动量排序）

| 文件 | 动作 | 关键改动 |
|---|---|---|
| **新增 `src/db/pg.ts`** | 新建 | PG 连接池（`pg` 库）+ paste 的 4 个语义方法 |
| **新增 `src/db/redis.ts`** | 新建 | Redis 客户端（`ioredis`）+ 原子限流 + 缓存读写 |
| `src/services/paste.service.ts` | 重写存储调用 | `db.prepare(...).bind()` → 调用 `pg` 语义方法；ID 碰撞改判 PG 错误码 `23505`（不再字符串匹配） |
| `src/services/rate-limit.service.ts` | 重写 | KV 的 get/put → Redis `INCR`+`EXPIRE` 原子操作（顺手修 TOCTOU） |
| `src/services/captcha.service.ts` | **删除** | 关闭验证码，整个文件移除 |
| `src/middleware/rate-limit.ts` | 微调 | `c.env.LIMITER` → 注入 Redis 客户端；IP 取值改兼容（无 `CF-Connecting-IP` 时取 XFF/X-Real-IP） |
| `src/routes/create.ts` | 删验证逻辑 | 移除 captcha 流程，只留 body 校验 + `createPaste` |
| `src/routes/config.ts` | 微调 | 移除 `turnstileSiteKey`，保留 maxContentSize/expirationDays |
| `src/index.ts` | 重构 | 移除 `ASSETS` 相关 7 处路由 + `scheduled` handler；改用 Bun serve；cron 用 node-cron |
| `src/config.ts` | 改类型 | `Bindings`（CF bindings）→ 普通 `process.env` 读取；移除 D1/KV/ASSETS/Fetcher 类型 |

### 3.2 PostgreSQL 层（`src/db/pg.ts`）

**schema 迁移**（D1/SQLite → PG），改动极小：

```sql
-- created_at 用 BIGINT 存毫秒（与现有一致，零数据迁移成本）
CREATE TABLE IF NOT EXISTS pastes (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  language TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pastes_created_at ON pastes(created_at);
```

**语义方法**（替换原来的 `D1Database` 散调用）：

```ts
// src/db/pg.ts
getPasteById(id): Promise<PasteRow | null>       // SELECT * WHERE id = ?
insertPaste({id, content, type, language, created_at}): Promise<void>
// INSERT 失败时抛错误码 23505（唯一约束）→ service 层捕获做碰撞重试
deletePaste(id): Promise<void>                     // 懒删除 / cron 清理
deleteExpired(olderThan: number): Promise<number>  // cron 清理，返回删除行数
```

**ID 碰撞重试改进**：原代码 `msg.includes('UNIQUE constraint failed')` 是字符串匹配，脆弱。PG 下用 `err.code === '23505'` 精准判断唯一约束冲突。

### 3.3 Redis 限流（顺手修 TOCTOU）

原代码 KV 的 read-then-write 有竞态：并发下两个请求都读到 count=2，都通过检查，都写 3。改用 Redis **原子操作**：

```ts
// src/db/redis.ts —— INCR 是原子的，天然解决 TOCTOU
async checkRateLimit(ip: string) {
  const minKey = `rl:min:${ip}`, hrKey = `rl:hr:${ip}`
  const [minCount, hrCount] = await Promise.all([
    redis.incr(minKey), redis.incr(hrKey),
  ])
  // 首次自增时设过期
  if (minCount === 1) await redis.expire(minKey, 60)
  if (hrCount === 1) await redis.expire(hrKey, 3600)
  return minCount > 3 || hrCount > 10
    ? { allowed: false, remaining: 0 }
    : { allowed: true, remaining: Math.min(3 - minCount, 10 - hrCount) }
}
```

限流阈值沿用现有配置（3 次/分钟、10 次/小时），通过 `RATE_LIMIT` 常量集中管理。

### 3.4 Redis 读缓存（真正的性能杠杆）

只在 **GET 读** 路径加缓存，写路径保持简单：

```
GET /api/paste/:id:
  1. redis.get("paste:{id}") → 命中？反序列化返回（快路径，~1ms）
  2. 未命中 → 查 PG → 回填缓存（TTL = 剩余有效期，到期自动失效）
  3. 过期/不存在 → 不缓存，返回 404/410
```

**缓存一致性保证**（pastebin 特点：创建后不可编辑、只读直到过期）：
- 内容只读 → **无脏读风险**，缓存可放心长期存。
- 过期靠 TTL：写缓存时 `EX = 剩余秒数`，到期自动删；懒删除逻辑仍兜底。
- 失效边界：若 paste 已缓存、随后过期被 cron 删，最坏情况是缓存留到 TTL 到期——无害（响应时仍比对 `created_at`，返回过期提示）。

热点 paste 命中率高，PG 读压力大幅下降。

### 3.5 关闭验证码的影响与兜底

移除 `captcha.service.ts` 后，限流成为唯一防刷防线。现有阈值（3/min、10/hr）足以挡住无脑刷。若后续被针对性攻击，可重新引入 Turnstile（其 siteverify 是公网 API，自托管也能调）或换 hCaptcha——预留 `src/services/captcha.service.ts` 这个位置即可。

---

## 4. 前端改造

前端是标准 Vite + TS，**和 Cloudflare 无关，零架构改动**。唯一要动的是移除 Turnstile：

| 文件 | 动作 |
|---|---|
| `frontend/src/editor/captcha.ts` | **删除** |
| `frontend/src/config.ts` | 移除 `turnstileSiteKey` 相关 |
| `frontend/src/editor/index.ts` | 移除 captcha 初始化/拦截逻辑，提交直接走 |
| `frontend/src/ui/modal.ts` | 移除验证码弹窗分支 |
| `frontend/index.html` | 移除 Turnstile `<script>` 标签 |
| `frontend/src/global.d.ts` `window.d.ts` `style.css` | 移除 turnstile 类型声明和样式 |

构建产物 `dist/` 仍由 `bun run build` 产出，Caddy 直服。**API 路径不变**（仍是 `/api/create` 等），前端无需改请求地址。

---

## 5. 部署设计

### 5.1 静态资源构建方式

**关键认识：app 容器只服务 API，不碰静态资源；`dist/` 只有宿主机 Caddy 需要读。** 因此 app 的 Dockerfile 不需要包含 `dist/`。

采用**宿主机构建**方案（最简单，首次部署推荐）：

```bash
# 宿主机直接构建（需装 bun）
bun install
bun run build   # 产出 dist/，Caddy 直接指向它
```

这样 app 容器的 Dockerfile 也最干净（见 5.3）。

> **可选项——容器内构建（追求可复现、不在宿主机装 bun）：** 在 app 的 Dockerfile 里多阶段构建时跑 `bun run build`，再用一次性的 sidecar 容器或 `docker cp` 把 `dist/` 拷到宿主机供 Caddy 使用。更复杂，本设计默认不采用，按需再上。

更新静态资源：重新 `bun run build`（宿主机方案），Caddy 立即服务新文件。

### 5.2 Caddyfile（复用用户已有的 Caddy）

在现有 Caddy 配置里加一段 site：

```caddy
share.example.com {
    # 静态资源直服（index/viewer/404 + assets）
    root * /var/www/sharebin
    encode gzip zstd

    # /:id（2-10 位字母数字）→ viewer.html
    @pastePath path_regexp ^/[a-zA-Z0-9]{2,10}$
    rewrite @pastePath /viewer.html
    try_files {path} /index.html

    # API 反代到 app 容器
    handle /api/* {
        reverse_proxy localhost:3000
    }

    # 其余走静态文件
    handle {
        file_server
    }
}
```

`localhost:3000` 是 app 容器映射到宿主机的端口（compose 里 `ports: ["127.0.0.1:3000:3000"]`，只绑 localhost，不对外）。

### 5.3 app 的 Dockerfile + docker-compose.yml

app 容器只服务 API，不需要 `dist/`：

```dockerfile
# Dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY tsconfig.json ./
EXPOSE 3000
CMD ["bun", "src/index.ts"]
```

```yaml
# docker-compose.yml
services:
  app:
    build: .
    container_name: sharebin-app
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://sharebin:${PG_PASSWORD}@postgres:5432/sharebin
      REDIS_URL: redis://redis:6379/0    # 用容器名连内网
      NODE_ENV: production
    ports:
      - "127.0.0.1:3000:3000"   # 只绑 localhost，由 Caddy 反代
    depends_on: [postgres]
    networks: [sharebin-net]

  postgres:
    image: postgres:16-alpine
    container_name: sharebin-pg
    restart: unless-stopped
    environment:
      POSTGRES_DB: sharebin
      POSTGRES_USER: sharebin
      POSTGRES_PASSWORD: ${PG_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks: [sharebin-net]
    # 不暴露端口，仅内网

volumes:
  pgdata:

networks:
  sharebin-net:
    external: true   # 需手动 docker network create sharebin-net
```

**Redis 接入方式**（二选一，取决于用户现有 redis 容器怎么起的）：
- 若现有 redis 容器已属于某 network：在 compose 里让 app 也加入该 network，用容器名连。
- 否则：`docker network connect sharebin-net <redis容器名>` 把它接进来，app 用容器名 `redis` 连。

### 5.4 cron 清理

原 `scheduled` handler 用 CF 的 Cron Trigger。自托管后用 **node-cron** 在 app 进程内起定时任务：

```ts
// app 启动时
import cron from 'node-cron'
cron.schedule('0 * * * *', () => deleteExpired(Date.now() - EXPIRATION_TTL))
```

每小时跑一次，与原 cron 表达式一致。单进程应用最省事，不引入额外组件。

---

## 6. 配置与环境变量

从 CF bindings/secrets 迁移到 `process.env`：

| 原 binding/secret | 新环境变量 | 说明 |
|---|---|---|
| `DB` (D1) | `DATABASE_URL` | PG 连接串 |
| `LIMITER` (KV) | `REDIS_URL` | Redis 连接串 |
| `ASSETS` | （移除） | Caddy 接管静态资源 |
| `TURNSTILE_SITE_KEY` | （移除） | 关闭验证码 |
| `TURNSTILE_SECRET_KEY` | （移除） | 关闭验证码 |
| `COOKIE_SECRET` | （移除） | 仅 captcha 签名 cookie 用，随 captcha 移除 |
| - | `NODE_ENV` | `production` |
| - | `PG_PASSWORD` | compose 用，PG 容器初始化 + app 连接 |

`.env.example` 提供模板。

---

## 7. 迁移步骤（高层次）

1. 新建 `src/db/pg.ts`、`src/db/redis.ts` 抽象层。
2. 改造 `paste.service.ts`（D1 → pg 语义方法 + 错误码判断）。
3. 重写 `rate-limit.service.ts`（Redis 原子限流）。
4. 删除 `captcha.service.ts`，清理 `create.ts` / `config.ts` 的验证码引用。
5. 改 `config.ts`：`Bindings` → `process.env` 类型。
6. 重构 `index.ts`：移除 ASSETS/scheduled，接 Bun serve + node-cron。
7. 移除前端 Turnstile（6 个文件）。
8. 新增 `Dockerfile`、`docker-compose.yml`、`.env.example`，更新 `schema.sql`（→ PG 语法）。
9. 编写 Caddy 配置示例。
10. 类型检查 + 本地 docker compose 验证。

> 实现计划详见后续 writing-plans 产物。

---

## 8. 不在本次范围（YAGNI）

- **不做** 数据从 D1 的历史迁移（用户未要求；新部署从空库开始）。
- **不做** Prometheus/监控/告警接入（用户未要求）。
- **不做** 水平扩展/多实例（单进程 + PG 连接池已足够当前规模）。
- **不重新引入** Turnstile 或替代验证码（用户明确关闭；预留位置，需要时再加）。
- **不做** Redis 限流以外的安全加固（如 WAF、IP 黑名单）——Caddy 层可后续按需加。
