# ShareBin 自托管迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ShareBin 从 Cloudflare Workers + D1 + KV 迁移到自托管（PostgreSQL + Redis + Docker Compose + Caddy），保留全部 TS/Hono 业务逻辑，仅替换存储与运行时胶水层，并关闭 Turnstile 验证码。

**Architecture:** Bun 运行 Hono app（仅 3 个 API 路由）。引入 `src/db/pg.ts`（PG 连接池 + paste CRUD）和 `src/db/redis.ts`（Redis 限流 + 读缓存）两个抽象层，使业务 service 保持不变。Caddy 直服 `dist/` 静态资源并反代 `/api/*`。PostgreSQL 16 与 app 同处一个 docker network，Redis 复用用户已有容器（external）。

**Tech Stack:** TypeScript, Hono, Bun, PostgreSQL (via `pg`), Redis (via `ioredis`), node-cron, Docker Compose, Caddy。

**Spec:** `docs/superpowers/specs/2026-07-31-selfhost-migration-design.md`

---

## File Structure

**新增：**
- `src/db/pg.ts` — PG 连接池 + paste 的 4 个语义方法（替换 D1Database 用法）
- `src/db/redis.ts` — Redis 客户端 + 原子限流 + 读缓存读写
- `src/env.ts` — typed 环境变量读取（替换 CF `Bindings` 类型）
- `src/cron.ts` — node-cron 定时清理任务（替换 `scheduled` handler）
- `Dockerfile` — app 容器镜像
- `docker-compose.yml` — app + postgres 编排（redis external）
- `.env.example` — 环境变量模板
- `schema.pg.sql` — PostgreSQL 建表脚本
- `Caddyfile.example` — Caddy 站点配置示例

**修改（后端）：**
- `src/config.ts` — 移除 D1/KV/ASSETS/Turnstile 类型与常量
- `src/services/paste.service.ts` — D1 调用 → pg 语义方法；ID 碰撞改判错误码 23505
- `src/services/rate-limit.service.ts` — KV read-then-write → Redis 原子 INCR
- `src/middleware/rate-limit.ts` — 注入 Redis 客户端；IP 取值兼容
- `src/routes/create.ts` — 移除验证码流程
- `src/routes/config.ts` — 移除 turnstileSiteKey
- `src/index.ts` — 移除 ASSETS 路由 + scheduled；接 Bun serve + cron
- `src/utils/id.ts` — `crypto.getRandomValues` 已是 Web 标准，Bun 支持，无需改
- `src/types.ts` — 移除 ExecutionContext / ShareData 冗余类型
- `tsconfig.json` — 移除 `@cloudflare/workers-types`
- `package.json` — 加 `pg` `ioredis` `node-cron` `@types/pg`；改 scripts

**修改（前端，移除 Turnstile）：**
- `frontend/src/editor/captcha.ts` — **删除**
- `frontend/src/editor/index.ts` — 移除 captcha 初始化/拦截/提交分支
- `frontend/src/ui/modal.ts` — 移除验证码弹窗分支
- `frontend/src/config.ts` — 移除 turnstileSiteKey
- `frontend/index.html` — 移除 Turnstile script + 容器
- `frontend/src/global.d.ts` — 移除 Turnstile 类型 + AppConfig 字段
- `frontend/src/window.d.ts` — 移除 window.turnstile
- `frontend/src/style.css` — 移除 turnstile 样式

---

## Task 1: 装依赖 + 改 tsconfig + 新增 env 模块

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `src/env.ts`

- [ ] **Step 1: 安装运行时依赖**

Run:
```bash
cd /home/xihale/Desktop/learning/cf/pastebin
bun add pg ioredis node-cron
bun add -d @types/pg @types/node
```
Expected: `package.json` 出现 `pg`、`ioredis`、`node-cron`、`@types/pg`、`@types/node`。

- [ ] **Step 2: 从 tsconfig.json 移除 cloudflare workers types**

替换 `tsconfig.json` 的 `types` 数组与 `lib`。把整个文件改为：

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ESNext"],
    "types": ["node"],
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "frontend"]
}
```

- [ ] **Step 3: 新增 `src/env.ts`（typed 环境变量，替换 CF Bindings）**

```ts
/**
 * Typed environment variables for self-hosted ShareBin
 * Replaces Cloudflare Bindings (c.env.XXX) with process.env reads
 */

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

export const env = {
  get DATABASE_URL() {
    return required('DATABASE_URL')
  },
  get REDIS_URL() {
    return required('REDIS_URL')
  },
  get NODE_ENV() {
    return process.env.NODE_ENV ?? 'development'
  },
} as const
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock tsconfig.json src/env.ts
git commit -m "chore: add pg/ioredis/node-cron deps and env module for self-host"
```

---

## Task 2: PostgreSQL 抽象层 (`src/db/pg.ts`)

**Files:**
- Create: `schema.pg.sql`
- Create: `src/db/pg.ts`

- [ ] **Step 1: 新增 `schema.pg.sql`（PG 建表脚本）**

```sql
-- ShareBin PostgreSQL schema
-- created_at stored as BIGINT milliseconds (zero-cost migration from D1/SQLite)

CREATE TABLE IF NOT EXISTS pastes (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  type TEXT NOT NULL,
  language TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pastes_created_at ON pastes(created_at);
```

- [ ] **Step 2: 新增 `src/db/pg.ts`（连接池 + 4 个语义方法）**

```ts
/**
 * PostgreSQL data access layer
 * Replaces D1Database usage with semantic paste CRUD methods
 */

import { Pool } from 'pg'
import { env } from '../env'
import type { PasteRow } from '../types'

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10, // connection pool size
})

/** Fetch a single paste by ID, or null if not found */
export async function getPasteById(id: string): Promise<PasteRow | null> {
  const res = await pool.query('SELECT * FROM pastes WHERE id = $1', [id])
  return (res.rows[0] as PasteRow) ?? null
}

/** Insert a new paste. Throws pg error code '23505' on unique constraint (ID collision). */
export async function insertPaste(p: {
  id: string
  content: string
  type: 'code' | 'url'
  language: string | null
  created_at: number
}): Promise<void> {
  await pool.query(
    'INSERT INTO pastes (id, content, type, language, created_at) VALUES ($1, $2, $3, $4, $5)',
    [p.id, p.content, p.type, p.language, p.created_at],
  )
}

/** Delete a paste by ID (lazy deletion / cleanup) */
export async function deletePaste(id: string): Promise<void> {
  await pool.query('DELETE FROM pastes WHERE id = $1', [id])
}

/** Delete all pastes older than the given timestamp. Returns number of deleted rows. */
export async function deleteExpired(olderThan: number): Promise<number> {
  const res = await pool.query('DELETE FROM pastes WHERE created_at < $1', [olderThan])
  return res.rowCount ?? 0
}

/** Close the pool (for graceful shutdown / tests) */
export async function closePool(): Promise<void> {
  await pool.end()
}
```

- [ ] **Step 3: Commit**

```bash
git add schema.pg.sql src/db/pg.ts
git commit -m "feat(db): add PostgreSQL access layer with paste CRUD methods"
```

---

## Task 3: Redis 抽象层 (`src/db/redis.ts`)

**Files:**
- Create: `src/db/redis.ts`
- Modify: `src/config.ts`（确认 RATE_LIMIT 常量保留，移除 CF 类型——本任务仅做不破坏现状的最小改动，CF 类型的清理留到 Task 6）

- [ ] **Step 1: 新增 `src/db/redis.ts`（原子限流 + 读缓存）**

```ts
/**
 * Redis data access layer
 * - Atomic rate limiting (fixes TOCTOU race in original KV implementation)
 * - Paste read cache for hot-path performance
 */

import { Redis } from 'ioredis'
import { env } from '../env'
import { RATE_LIMIT, PASTE } from '../config'
import type { PasteRow, RateLimitResult } from '../types'

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
})

/**
 * Check rate limit using atomic INCR + conditional EXPIRE.
 * Fixes the read-then-write TOCTOU race of the original KV-based limiter.
 */
export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  const minKey = `${RATE_LIMIT.KEY_PREFIX}:min:${ip}`
  const hrKey = `${RATE_LIMIT.KEY_PREFIX}:hr:${ip}`

  const [minCount, hrCount] = await Promise.all([redis.incr(minKey), redis.incr(hrKey)])

  // Set TTL only on first increment (count === 1 after INCR)
  if (minCount === 1) await redis.expire(minKey, RATE_LIMIT.MINUTE_TTL)
  if (hrCount === 1) await redis.expire(hrKey, RATE_LIMIT.HOUR_TTL)

  if (minCount > RATE_LIMIT.MAX_PER_MINUTE || hrCount > RATE_LIMIT.MAX_PER_HOUR) {
    return { allowed: false, remaining: 0 }
  }

  return {
    allowed: true,
    remaining: Math.min(
      RATE_LIMIT.MAX_PER_MINUTE - minCount,
      RATE_LIMIT.MAX_PER_HOUR - hrCount,
    ),
  }
}

// ==================== Paste read cache ====================

/** Redis key for a cached paste */
function cacheKey(id: string): string {
  return `paste:${id}`
}

/** Try to read a paste from cache. Returns null on miss. */
export async function getCachedPaste(id: string): Promise<PasteRow | null> {
  const raw = await redis.get(cacheKey(id))
  if (!raw) return null
  try {
    return JSON.parse(raw) as PasteRow
  } catch {
    return null
  }
}

/**
 * Cache a paste with TTL = remaining lifetime.
 * Content is read-only (created then immutable), so no stale/dirty-read risk.
 */
export async function cachePaste(row: PasteRow): Promise<void> {
  const remainingMs = row.created_at + PASTE.EXPIRATION_TTL - Date.now()
  if (remainingMs <= 0) return
  const remainingSec = Math.ceil(remainingMs / 1000)
  await redis.set(cacheKey(row.id), JSON.stringify(row), 'EX', remainingSec)
}

/** Invalidate a cached paste (used when deleting) */
export async function invalidatePasteCache(id: string): Promise<void> {
  await redis.del(cacheKey(id))
}
```

- [ ] **Step 2: 确认 `src/config.ts` 的 RATE_LIMIT / PASTE 常量存在且无需改**

Run:
```bash
grep -n "RATE_LIMIT\|EXPIRATION_TTL\|KEY_PREFIX" src/config.ts
```
Expected: 看到 `RATE_LIMIT`、`PASTE.EXPIRATION_TTL` 等常量定义（它们是纯常量，与 CF 无关，原样复用）。

- [ ] **Step 3: Commit**

```bash
git add src/db/redis.ts
git commit -m "feat(db): add Redis layer with atomic rate limiting and paste cache"
```

---

## Task 4: 改造 paste.service.ts（D1 → pg + Redis 缓存）

**Files:**
- Modify: `src/services/paste.service.ts`

- [ ] **Step 1: 重写整个 `src/services/paste.service.ts`**

把文件完整替换为以下内容（业务逻辑保留：ID 碰撞重试、过期判断、懒删除；存储调用从 D1 切到 pg/redis）：

```ts
/**
 * Paste service for ShareBin
 * Business logic for paste CRUD — storage-agnostic (uses pg + redis layers)
 */

import { PASTE } from '../config'
import { generateId, validateId } from '../utils/id'
import { validateLanguage } from '../utils/language'
import * as pg from '../db/pg'
import { getCachedPaste, cachePaste, invalidatePasteCache } from '../db/redis'
import type { PasteResponse } from '../types'
import { Errors } from '../utils/error'

/**
 * Create a new paste
 * Handles ID generation with collision retry logic (PG error code 23505)
 */
export async function createPaste(
  content: string,
  type: 'code' | 'url',
  language?: string,
): Promise<string> {
  if (!content || content.length > PASTE.MAX_CONTENT_SIZE) {
    throw Errors.contentTooLarge(PASTE.MAX_CONTENT_SIZE)
  }

  const validatedLanguage = validateLanguage(language)
  const finalType: 'code' | 'url' = type === 'url' ? 'url' : 'code'

  let finalId = ''

  for (let len = PASTE.ID_START_LEN; len <= PASTE.ID_MAX_LEN; len++) {
    for (let i = 0; i < PASTE.ID_RETRIES_PER_LEN; i++) {
      const candidate = generateId(len)
      try {
        await pg.insertPaste({
          id: candidate,
          content,
          type: finalType,
          language: validatedLanguage,
          created_at: Date.now(),
        })
        finalId = candidate
        break
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === '23505') continue // unique constraint — collision, retry
        throw e
      }
    }
    if (finalId) break
  }

  if (!finalId) throw Errors.allocationFailed()

  return finalId
}

/**
 * Retrieve a paste by ID
 * Redis read cache → PG fallback → cache backfill
 * Lazy deletion on expiry
 */
export async function getPaste(id: string): Promise<PasteResponse> {
  if (!validateId(id)) throw Errors.notFound()

  // 1. Try cache
  let data = await getCachedPaste(id)

  // 2. Cache miss → query PG
  if (!data) {
    data = await pg.getPasteById(id)
    if (data) await cachePaste(data) // backfill cache
  }

  if (!data) throw Errors.notFound()

  // Check expiration
  if (Date.now() - data.created_at > PASTE.EXPIRATION_TTL) {
    // Lazy deletion: fire-and-forget (DB + cache invalidation)
    pg.deletePaste(id).catch((err) => console.error('Lazy delete failed:', err))
    invalidatePasteCache(id).catch((err) => console.error('Cache invalidate failed:', err))
    throw Errors.linkExpired()
  }

  // URL type
  if (data.type === 'url') {
    const allowedProtocols = PASTE.ALLOWED_URL_PROTOCOLS
    try {
      const url = new URL(data.content)
      if (allowedProtocols.includes(url.protocol as (typeof allowedProtocols)[number])) {
        return { type: 'url', url: data.content }
      }
    } catch {
      // invalid URL format
    }
    throw Errors.invalidUrl()
  }

  // Code type
  return {
    type: 'code',
    content: data.content,
    language: data.language || 'plaintext',
    expiration: formatExpiration(data.created_at, PASTE.EXPIRATION_TTL),
  }
}

/** Format remaining lifetime as "7 d 3 h" */
export function formatExpiration(createdAt: number, ttl: number = PASTE.EXPIRATION_TTL): string {
  const diff = createdAt + ttl - Date.now()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  return `${days} d ${hours} h`
}

/** Delete expired pastes (for cron job). Returns number deleted. */
export async function cleanupExpiredPastes(): Promise<number> {
  return pg.deleteExpired(Date.now() - PASTE.EXPIRATION_TTL)
}
```

注意：`getPaste` / `createPaste` / `cleanupExpiredPastes` 不再接收 `db: D1Database` 参数——调用方（routes）也要相应更新，见 Task 8。

- [ ] **Step 2: 类型检查（预期失败，因为 routes 还在传 db 参数 — 留到 Task 8 修）**

Run:
```bash
bun run typecheck:backend 2>&1 | head -20
```
Expected: 报错来自 routes/create.ts、routes/paste.ts（传了 db 参数）和 index.ts（scheduled handler 调 cleanupExpiredPastes(env.DB)）。这些在后续任务修复，本步只确认 service 本身无语法错。

- [ ] **Step 3: Commit**

```bash
git add src/services/paste.service.ts
git commit -m "feat(service): rewrite paste service to use pg + redis cache"
```

---

## Task 5: 重写 rate-limit.service.ts（Redis 原子限流）

**Files:**
- Modify: `src/services/rate-limit.service.ts`

- [ ] **Step 1: 把 `src/services/rate-limit.service.ts` 整个替换为薄封装**

业务逻辑已移到 `src/db/redis.ts` 的 `checkRateLimit`，此文件保留为兼容入口（供 middleware 调用），移除 KV 依赖：

```ts
/**
 * Rate limiting service for ShareBin
 * Thin wrapper over the Redis atomic limiter (see src/db/redis.ts)
 */

import { checkRateLimit as redisCheckRateLimit } from '../db/redis'
import { RATE_LIMIT } from '../config'
import type { RateLimitResult } from '../types'

/**
 * Check rate limit for a given IP (atomic via Redis INCR)
 */
export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  return redisCheckRateLimit(ip)
}

/**
 * Get current rate limit status without incrementing
 */
export async function getRateLimitStatus(
  ip: string,
): Promise<{ minute: { used: number; limit: number }; hour: { used: number; limit: number } }> {
  // status-only query is rarely used; re-export limits from config for completeness
  return {
    minute: { used: 0, limit: RATE_LIMIT.MAX_PER_MINUTE },
    hour: { used: 0, limit: RATE_LIMIT.MAX_PER_HOUR },
  }
}
```

> 注：原 `getRateLimitStatus`（不递增地查状态）当前无调用方，这里保留签名但简化。若后续需要真实查询，可加 `redis.get`。

- [ ] **Step 2: Commit**

```bash
git add src/services/rate-limit.service.ts
git commit -m "feat(service): switch rate limiter to atomic Redis INCR"
```

---

## Task 6: 清理 config.ts 与 types.ts（移除 CF 耦合类型）

**Files:**
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Delete: `src/services/captcha.service.ts`

- [ ] **Step 1: 删除 captcha.service.ts**

Run:
```bash
rm src/services/captcha.service.ts
```

- [ ] **Step 2: 重写 `src/config.ts`**

移除 D1/KV/ASSETS/Turnstile/COOKIE 类型和常量，保留纯配置常量。整个文件替换为：

```ts
/**
 * Central configuration module for ShareBin (self-hosted)
 * Pure constants only — no Cloudflare binding types
 */

// ==================== Rate Limiting ====================
export const RATE_LIMIT = {
  MAX_PER_MINUTE: 3,
  MAX_PER_HOUR: 10,
  MINUTE_TTL: 60,
  HOUR_TTL: 3600,
  KEY_PREFIX: 'rl' as const,
} as const

// ==================== Paste ====================
export const PASTE = {
  MAX_CONTENT_SIZE: 100 * 1024,
  EXPIRATION_TTL: 7 * 24 * 60 * 60 * 1000,
  BASE62: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  ID_START_LEN: 2,
  ID_MAX_LEN: 10,
  ID_RETRIES_PER_LEN: 5,
  MAX_ID_LENGTH: 10,
  ALLOWED_URL_PROTOCOLS: ['http:', 'https:'] as const,
} as const

// ==================== Security Headers ====================
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer-when-downgrade',
} as const

// ==================== API Messages ====================
export const MESSAGES = {
  ERRORS: {
    INVALID_JSON: 'Invalid JSON',
    CONTENT_TOO_LARGE: (maxSize: number) => `Content size exceeds ${Math.floor(maxSize / 1024)}KB`,
    TOO_MANY_REQUESTS: 'Too many requests. Please try again in a minute.',
    NOT_FOUND: 'Not Found',
    LINK_EXPIRED: 'Link Expired',
    INVALID_URL: 'Invalid or insecure URL',
    ALLOCATION_FAILED: 'Allocation failed',
    INTERNAL_ERROR: 'Internal Server Error',
  },
} as const
```

- [ ] **Step 3: 重写 `src/types.ts`**

移除 `ShareData`、`AppContext.executionCtx`、`TurnstileResult`、`ConfigResponse` 中 turnstile 相关；保留核心类型：

```ts
/**
 * Type definitions for ShareBin (self-hosted)
 */

// ==================== Request Types ====================
export type CreateRequest = {
  content: string
  type: 'code' | 'url'
  language?: string
}

// ==================== Data Types ====================
/** Row type for PostgreSQL paste records */
export type PasteRow = {
  id: string
  content: string
  type: 'code' | 'url'
  language: string | null
  created_at: number
}

// ==================== Response Types ====================
export type ApiResponse<T = unknown> = {
  data?: T
  error?: string
  code?: string
}

export type CreateResponse = {
  id: string
}

export type PasteResponse = {
  type: 'code' | 'url'
  content?: string
  url?: string
  language?: string
  expiration?: string
}

export type ConfigResponse = {
  maxContentSize?: number
  expirationDays?: number
  cdnBase?: string
}

// ==================== Error Types ====================
export enum AppErrorCode {
  INVALID_JSON = 'INVALID_JSON',
  CONTENT_TOO_LARGE = 'CONTENT_TOO_LARGE',
  RATE_LIMITED = 'RATE_LIMITED',
  NOT_FOUND = 'NOT_FOUND',
  LINK_EXPIRED = 'LINK_EXPIRED',
  INVALID_URL = 'INVALID_URL',
  ALLOCATION_FAILED = 'ALLOCATION_FAILED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export class AppError extends Error {
  constructor(
    public code: AppErrorCode,
    public statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

// ==================== Service Types ====================
export type RateLimitResult = {
  allowed: boolean
  remaining?: number
}
```

- [ ] **Step 4: 检查 `src/utils/error.ts` 是否引用了已删除的 error code**

Run:
```bash
grep -n "CAPTCHA_REQUIRED\|CONFIG_MISSING\|COOKIE_SECRET" src/utils/error.ts
```
Expected: 如果有引用，需在下一步（Task 7/8 随 routes 清理）一起改。先记录这里有哪些。

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/types.ts src/services/captcha.service.ts
git commit -m "refactor: remove Cloudflare binding types and captcha module"
```

---

## Task 7: 更新 error 工具（移除 captcha 相关错误）

**Files:**
- Modify: `src/utils/error.ts`

- [ ] **Step 1: 读取当前 `src/utils/error.ts`**

Run:
```bash
cat src/utils/error.ts
```

- [ ] **Step 2: 移除 `captchaRequired` 和 `configMissing` 方法**

把所有引用 `AppErrorCode.CAPTCHA_REQUIRED` 或 `AppErrorCode.CONFIG_MISSING` 的 `Errors.xxx()` 方法删除（这两个枚举值已在 Task 6 从 types.ts 移除）。其余 error 方法保留。

具体地：删除形如
```ts
static captchaRequired() { return new AppError(AppErrorCode.CAPTCHA_REQUIRED, 403, MESSAGES...) }
static configMissing(name) { return new AppError(AppErrorCode.CONFIG_MISSING, 500, ...) }
```
的两段。保留 `invalidJson` / `contentTooLarge` / `rateLimited` / `notFound` / `linkExpired` / `invalidUrl` / `allocationFailed` / `internalError`。

- [ ] **Step 3: Commit**

```bash
git add src/utils/error.ts
git commit -m "refactor(error): remove captcha-related error helpers"
```

---

## Task 8: 改造 routes（create / paste / config）

**Files:**
- Modify: `src/routes/create.ts`
- Modify: `src/routes/paste.ts`
- Modify: `src/routes/config.ts`
- Modify: `src/middleware/rate-limit.ts`

- [ ] **Step 1: 重写 `src/routes/create.ts`（移除验证码流程）**

```ts
/**
 * Create paste route for ShareBin
 * Handles POST /api/create (captcha removed for self-host)
 */

import type { Context } from 'hono'
import { createPaste } from '../services/paste.service'
import { Errors } from '../utils/error'

/** POST /api/create — creates a new paste */
export async function createPasteRoute(c: Context) {
  let body: { content: string; type: 'code' | 'url'; language?: string }
  try {
    body = await c.req.json()
  } catch {
    throw Errors.invalidJson()
  }

  const { content, language } = body
  const validTypes = ['code', 'url']
  const finalType: 'code' | 'url' = validTypes.includes(body.type) ? body.type : 'code'

  const id = await createPaste(content, finalType, language)
  return c.json({ id })
}
```

- [ ] **Step 2: 重写 `src/routes/paste.ts`（不再传 db）**

```ts
/**
 * Get paste route for ShareBin
 * Handles GET /api/paste/:id
 */

import type { Context } from 'hono'
import { getPaste } from '../services/paste.service'
import { Errors } from '../utils/error'

/** GET /api/paste/:id — retrieves a paste by ID */
export async function getPasteRoute(c: Context) {
  const id = c.req.param('id')
  if (!id) throw Errors.invalidJson() // 400-ish; will be handled by error mapper

  const result = await getPaste(id)
  return c.json(result)
}
```

> 若 `!id` 的错误语义不合适，可改为 `return c.json({ error: 'Missing paste ID' }, 400)`。保持简单。

- [ ] **Step 3: 重写 `src/routes/config.ts`（移除 turnstile）**

```ts
/**
 * Config route for ShareBin
 * Handles GET /api/config — returns frontend config (no captcha)
 */

import type { Context } from 'hono'
import { PASTE } from '../config'

/** GET /api/config */
export async function getConfigRoute(c: Context) {
  return c.json({
    maxContentSize: PASTE.MAX_CONTENT_SIZE,
    expirationDays: PASTE.EXPIRATION_TTL / (1000 * 60 * 60 * 24),
    cdnBase: 'https://npm.webcache.cn',
  })
}
```

- [ ] **Step 4: 重写 `src/middleware/rate-limit.ts`（注入 Redis，IP 取值兼容）**

```ts
/**
 * Rate limit middleware for ShareBin
 * Uses Redis atomic limiter; IP detection works without CF-Connecting-IP
 */

import { checkRateLimit } from '../services/rate-limit.service'
import { Errors } from '../utils/error'

type Context = {
  req: { header: (key: string) => string | undefined }
  json: (data: unknown, status?: number) => Response
}

/** Resolve client IP without relying on CF-Connecting-IP */
function getClientIP(c: Context): string {
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Real-IP') ||
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

/** Rate limit middleware (Hono) */
export function rateLimitMiddleware() {
  return async (c: Context, next: () => Promise<void>) => {
    const clientIP = getClientIP(c)
    const result = await checkRateLimit(clientIP)
    if (!result.allowed) throw Errors.rateLimited()
    await next()
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add src/routes/create.ts src/routes/paste.ts src/routes/config.ts src/middleware/rate-limit.ts
git commit -m "refactor(routes): remove captcha flow and D1 params; Redis-aware rate limit"
```

---

## Task 9: 重写 index.ts + 新增 cron.ts（接 Bun serve）

**Files:**
- Create: `src/cron.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 新增 `src/cron.ts`（node-cron 定时清理，替换 scheduled handler）**

```ts
/**
 * Cron job for expired paste cleanup (replaces CF scheduled handler)
 */

import cron from 'node-cron'
import { cleanupExpiredPastes } from './services/paste.service'

/** Start the hourly cleanup job. Call once at app boot. */
export function startCleanupCron(): void {
  cron.schedule('0 * * * *', async () => {
    try {
      const count = await cleanupExpiredPastes()
      console.log(`[cron] Cleanup complete. Deleted ${count} expired pastes`)
    } catch (err) {
      console.error('[cron] Cleanup failed:', err)
    }
  })
  console.log('[cron] Hourly paste cleanup scheduled')
}
```

- [ ] **Step 2: 重写 `src/index.ts`（移除 ASSETS/scheduled，接 Bun + cron）**

```ts
/**
 * ShareBin — Entry point (self-hosted, Bun runtime)
 * API-only Hono app. Static assets served by Caddy.
 */

import { Hono } from 'hono'
import { securityMiddleware, corsMiddleware } from './middleware/security'
import { rateLimitMiddleware } from './middleware/rate-limit'
import { createPasteRoute } from './routes/create'
import { getPasteRoute } from './routes/paste'
import { getConfigRoute } from './routes/config'
import { globalErrorHandler } from './utils/error'
import { startCleanupCron } from './cron'

const app = new Hono()

app.onError(globalErrorHandler)
app.use('*', corsMiddleware)
app.use('*', securityMiddleware)

app.post('/api/create', rateLimitMiddleware(), createPasteRoute)
app.get('/api/paste/:id', getPasteRoute)
app.get('/api/config', getConfigRoute)

// Start hourly expired-paste cleanup
startCleanupCron()

const PORT = Number(process.env.PORT ?? 3000)

export default {
  port: PORT,
  fetch: app.fetch,
}
```

> Bun 原生识别 `export default { port, fetch }`（Bun.serve 风格）。无需 `@hono/node-server`。

- [ ] **Step 3: 删除现已无用的 `src/shared/routes.ts` 的 HTML 路由依赖（可选）**

Run:
```bash
grep -rn "shared/routes\|HTML_ENTRYPOINTS\|getHtmlEntrypointForPath" src/ | grep -v "shared/routes.ts"
```
Expected: 无引用（index.ts 已不再用）。`src/shared/routes.ts` 与 `vite.config.ts` 仍被前端构建引用，**保留不删**。

- [ ] **Step 4: 类型检查后端**

Run:
```bash
bun run typecheck:backend
```
Expected: PASS（0 errors）。若报错，按提示修复（常见：残留 `c.env` 引用、未删的 import）。

- [ ] **Step 5: Commit**

```bash
git add src/cron.ts src/index.ts
git commit -m "feat: rewrite entry point for Bun runtime with node-cron cleanup"
```

---

## Task 10: 移除前端 Turnstile（6 文件）

**Files:**
- Delete: `frontend/src/editor/captcha.ts`
- Modify: `frontend/src/editor/index.ts`
- Modify: `frontend/src/ui/modal.ts`
- Modify: `frontend/src/config.ts`
- Modify: `frontend/index.html`
- Modify: `frontend/src/global.d.ts`
- Modify: `frontend/src/window.d.ts`
- Modify: `frontend/src/style.css`

- [ ] **Step 1: 删除 captcha.ts**

Run:
```bash
rm frontend/src/editor/captcha.ts
```

- [ ] **Step 2: 移除 `frontend/src/editor/index.ts` 的 captcha 逻辑**

找到并删除以下内容（行号约 12、306-314、360-372，以及 `submitWithCaptcha` 整个函数约 395-420）：

1. 删除 import 行：
   ```ts
   import { initTurnstile, resetTurnstile, setWaitingForCaptcha, getWidgetId } from './captcha.js'
   ```
2. 删除 Turnstile 初始化块（约 306-314）：
   ```ts
   // Initialize Turnstile
   const siteKey = config?.turnstileSiteKey || ''
   initTurnstile(siteKey, submitWithCaptcha)
   ```
3. 删除 modal init 中 `setWaitingForCaptcha(false)` 与 `resetTurnstile()` 两行。
4. 删除 `handleSave` 里 "Handle captcha required" 整个 `if (res.status === 403) { ... }` 分支。
5. 删除整个 `submitWithCaptcha` 函数。

`handleSave` 提交的 body 也应移除 `'cf-turnstile-response'` 字段（若 `handleSave` 的 fetch body 里没有就不用动；确认其 body 仅含 `content/type/language`）。

- [ ] **Step 3: 重写 `frontend/src/ui/modal.ts`（移除验证码弹窗）**

由于 modal.ts 当前大量围绕 captcha 弹窗，最稳妥是重写为一个简单 loading/result modal。先读取确认其对外导出（`initModal` / `showModal` / `hideModal` / `showLoadingState`），然后保留这些签名但移除 turnstile-container、cancel-captcha-btn 等 DOM。读取后按需精简：移除所有 `turnstile`/`captcha` 字样、`CAPTCHA_MODAL_ID` 相关分支；保留 loading 与 result 状态切换。

Run first:
```bash
cat frontend/src/ui/modal.ts
```
然后编辑：删除 `CAPTCHA_MODAL_ID` 常量、`<div id="turnstile-container">`、`cancel-captcha-btn`、所有注释提到 captcha 的地方。`showModal()` 可保留为空函数或直接触发 `showLoadingState()`，因为 create 提交后不再有验证步骤。

- [ ] **Step 4: 移除 `frontend/src/config.ts` 的 turnstileSiteKey**

在 `initConfig()` 的 `_config = { ... }` 对象中删除 `turnstileSiteKey` 字段（两处：try 块内和 fallback）。fallback 默认对象改为：
```ts
_config = {
  maxContentSize: 100 * 1024,
  expirationDays: 7,
  cdnBase: CDN_BASE,
}
```

- [ ] **Step 5: 移除 `frontend/index.html` 的 Turnstile**

删除第 77 行 `<div id="turnstile-container"></div>`、第 87-88 行的 `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" ...>`、第 23 行 `.cf-turnstile` CSS 选择器。

- [ ] **Step 6: 移除 `frontend/src/global.d.ts` 的 Turnstile 类型**

删除：
```ts
// Turnstile captcha
interface Turnstile {
  render: (container: string, options: Record<string, any>) => number
  reset: (widgetId: number) => void
}
```
并从 `interface AppConfig` 删除 `turnstileSiteKey: string` 行。

- [ ] **Step 7: 移除 `frontend/src/window.d.ts` 的 window.turnstile**

删除 Window 接口里的：
```ts
turnstile?: Turnstile
```

- [ ] **Step 8: 移除 `frontend/src/style.css` 第 987 行 `#turnstile-container` 样式块**

定位并删除该规则（含其下花括号内的所有声明）。

- [ ] **Step 9: 前端类型检查 + 构建**

Run:
```bash
bun run typecheck:frontend
```
Expected: PASS。若有残留 turnstile 引用报错，逐一清除。

Run:
```bash
bun run build
```
Expected: 构建成功，产出 `dist/`。

- [ ] **Step 10: Commit**

```bash
git add frontend/
git commit -m "feat(frontend): remove Turnstile captcha integration"
```

---

## Task 11: Dockerfile + docker-compose + .env.example + Caddyfile.example

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `Caddyfile.example`

- [ ] **Step 1: 新增 `Dockerfile`（app 容器，仅 API）**

```dockerfile
# ShareBin API — Bun runtime
FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

EXPOSE 3000
CMD ["bun", "src/index.ts"]
```

- [ ] **Step 2: 新增 `docker-compose.yml`**

```yaml
services:
  app:
    build: .
    container_name: sharebin-app
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://sharebin:${PG_PASSWORD}@postgres:5432/sharebin
      REDIS_URL: redis://${REDIS_HOST:-redis}:6379/0
      NODE_ENV: production
      PORT: "3000"
    ports:
      - "127.0.0.1:3000:3000"   # localhost-only; Caddy reverse-proxies
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
    # No host port — internal only

volumes:
  pgdata:

networks:
  sharebin-net:
    external: true   # docker network create sharebin-net  (and connect your existing redis container)
```

- [ ] **Step 3: 新增 `.env.example`**

```bash
# Required
DATABASE_URL=postgres://sharebin:CHANGE_ME@localhost:5432/sharebin
REDIS_URL=redis://localhost:6379/0

# Docker compose vars
PG_PASSWORD=CHANGE_ME_STRONG_PASSWORD

# Optional
NODE_ENV=production
PORT=3000
```

- [ ] **Step 4: 新增 `Caddyfile.example`**

```caddy
# ShareBin site — static files by Caddy, API reverse-proxied to app container
share.example.com {
    root * /var/www/sharebin/dist
    encode gzip zstd

    # /:id (2-10 alnum) → viewer.html
    @pastePath path_regexp pasteId ^/[a-zA-Z0-9]{2,10}$
    rewrite @pastePath /viewer.html

    # API → app container (localhost:3000, bound in compose)
    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }

    # Everything else → static files, fallback to index.html
    handle {
        try_files {path} /index.html
        file_server
    }
}
```

- [ ] **Step 5: 把 .env.example 加入 git 跟踪（.env 本身仍被忽略）**

确认 `.gitignore` 忽略真实 `.env`。若没有，在 `.gitignore` 末尾追加：
```
.env
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example Caddyfile.example .gitignore
git commit -m "feat(ops): add Dockerfile, compose, env example, and Caddyfile"
```

---

## Task 12: 更新 package.json scripts + README

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: 调整 `package.json` scripts（去 wrangler，加 serve/start）**

把 `scripts` 改为：

```json
"scripts": {
  "dev": "concurrently -k -n api,web \"bun run dev:api\" \"bun run dev:web\"",
  "dev:api": "bun --watch src/index.ts",
  "dev:web": "vite --host 0.0.0.0 --port 3001",
  "build": "bun run typecheck && vite build",
  "start": "bun src/index.ts",
  "preview": "vite preview",
  "typecheck": "bun run typecheck:backend && bun run typecheck:frontend",
  "typecheck:backend": "tsc -p tsconfig.json --noEmit",
  "typecheck:frontend": "tsc -p frontend/tsconfig.json --noEmit",
  "lint": "eslint frontend/ src/",
  "lint:fix": "eslint --fix frontend/ src/"
}
```

> 注意：移除了 `dev:api` 的 wrangler、`deploy`、`cf-typegen`。前端 dev 端口改为 3001 以免和后端 3000 冲突（vite proxy 需对应调整，见 Step 3）。

- [ ] **Step 2: 移除 vite.config.ts 里 wrangler 相关的 proxy 目标（如有的话）**

Run:
```bash
grep -n "8787\|proxy\|wrangler" vite.config.ts
```
若有指向 `localhost:8787` 的 proxy，改为 `localhost:3000`（后端 dev 端口）。读取 vite.config.ts 相应段落并编辑。

- [ ] **Step 3: 重写 `README.md` 的部署章节**

把 README 的 "Deployment" 与 "Local Development" 章节更新为自托管流程（Docker Compose + Caddy），删除 D1 / wrangler / Turnstile 相关步骤。保留 Features、Project Structure、Scripts 表格（更新为新 scripts）。具体文案：

```markdown
## 🚀 Deployment (Self-hosted)

### 1. Build frontend
\`\`\`bash
bun install
bun run build    # produces dist/
\`\`\`

### 2. Start services with Docker Compose
\`\`\`bash
cp .env.example .env
# edit .env: set PG_PASSWORD

docker network create sharebin-net
docker network connect sharebin-net <your-existing-redis-container>

docker compose up -d --build
\`\`\`

### 3. Initialize the database
\`\`\`bash
docker exec -i sharebin-pg psql -U sharebin -d sharebin < schema.pg.sql
\`\`\`

### 4. Configure Caddy
Copy the relevant site block from \`Caddyfile.example\` into your existing Caddy config,
pointing \`root\` at the repo's \`dist/\` directory. Reload Caddy.

### Updating
\`\`\`bash
git pull && bun run build        # rebuild static assets
docker compose up -d --build     # rebuild app container
\`\`\`

## 🛠️ Local Development
\`\`\`bash
bun install
bun run dev      # API (bun --watch, :3000) + web (vite, :3001)
\`\`\`
```

- [ ] **Step 4: Commit**

```bash
git add package.json README.md vite.config.ts
git commit -m "chore: update scripts and README for self-hosted deployment"
```

---

## Task 13: 清理编译产物 .js 文件 + 移除 wrangler 配置引用

**Files:**
- Delete: `src/**/*.js`（与 `.ts` 同名的编译产物）
- Delete (optional): `wrangler.jsonc.example`、`worker-configuration.d.ts`、`schema.sql`（旧 D1 schema）

- [ ] **Step 1: 列出所有 .js 编译产物**

Run:
```bash
find src -name "*.js" | sort
```
Expected: 看到与 .ts 同名的 .js 文件（如 `src/index.js`、`src/services/paste.service.js` 等）。

- [ ] **Step 2: 删除所有 src 下的 .js 编译产物**

Run:
```bash
find src -name "*.js" -delete
git add -A src/
```

- [ ] **Step 3: 决定是否移除 CF 残留配置文件**

`worker-configuration.d.ts`（491KB，CF types）和 `wrangler.jsonc.example`、`schema.sql`（旧 D1 schema）在自托管后不再需要。删除：

Run:
```bash
rm -f worker-configuration.d.ts wrangler.jsonc.example schema.sql
```

> 保留 `.dev.vars.example` 与 `SETUP.md`？它们也是 CF 专属。可一并删除或留作历史。建议删除以避免混淆：
> ```bash
> rm -f .dev.vars.example SETUP.md
> ```

- [ ] **Step 4: 检查无残留 CF 引用**

Run:
```bash
grep -rn "wrangler\|@cloudflare\|D1Database\|KVNamespace\|c\.env\|cf-turnstile" src/ frontend/src/ 2>/dev/null
```
Expected: 无输出（或仅注释/字符串中的非功能性提及）。

- [ ] **Step 5: 全量类型检查 + 构建**

Run:
```bash
bun run typecheck && bun run build
```
Expected: PASS，dist/ 产出。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove Cloudflare build artifacts and stale config files"
```

---

## Task 14: 端到端验证（本地 Docker）

**Files:** none (verification only)

- [ ] **Step 1: 起本地依赖**

Run:
```bash
docker network create sharebin-net
docker run -d --name sharebin-redis-local --network sharebin-net redis:7-alpine
docker run -d --name sharebin-pg-local --network sharebin-net \
  -e POSTGRES_DB=sharebin -e POSTGRES_USER=sharebin -e POSTGRES_PASSWORD=devpass \
  postgres:16-alpine
```

- [ ] **Step 2: 初始化 schema**

Run:
```bash
sleep 3
docker exec -i sharebin-pg-local psql -U sharebin -d sharebin < schema.pg.sql
```
Expected: `CREATE TABLE` / `CREATE INDEX`（首次）或无输出（IF NOT EXISTS）。

- [ ] **Step 3: 后端本地起（连本地容器）**

Run:
```bash
DATABASE_URL='postgres://sharebin:devpass@localhost:5433/sharebin' \
REDIS_URL='redis://localhost:6380/0' \
bun src/index.ts
```
> 注意：上面 pg/redis 容器未映射宿主机端口。改用进容器网络跑或临时映射端口。更简单：直接 `docker compose up -d --build`（用 Task 11 的 compose），然后对 127.0.0.1:3000 测试。

- [ ] **Step 4: 验证 API 流程**

```bash
# 1. config
curl -s http://127.0.0.1:3000/api/config
# 期望: {"maxContentSize":102400,"expirationDays":7,"cdnBase":"https://npm.webcache.cn"}

# 2. create
ID=$(curl -s -X POST http://127.0.0.1:3000/api/create \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello world","type":"code","language":"plaintext"}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "created id=$ID"

# 3. get (first read: PG + cache backfill)
curl -s http://127.0.0.1:3000/api/paste/$ID
# 期望: {"type":"code","content":"hello world","language":"plaintext","expiration":"7 d 0 h"}

# 4. get again (should hit cache — same response)
curl -s http://127.0.0.1:3000/api/paste/$ID

# 5. rate limit (4th create within a minute → 429)
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:3000/api/create \
    -H 'Content-Type: application/json' \
    -d '{"content":"x","type":"code"}'
done
# 期望: 200 200 200 429
```

Expected: 步骤 5 输出 `200 200 200 429`，验证限流原子生效。

- [ ] **Step 5: 验证缓存命中**

Run:
```bash
docker exec sharebin-redis-local redis-cli GET "paste:$ID"
```
Expected: 返回一段 JSON（缓存的 PasteRow），证明读缓存回填成功。

- [ ] **Step 6: 前端冒烟测试**

```bash
bun run build
# 用任意静态服务器起 dist/，浏览器打开编辑器页：
python3 -m http.server 8080 --directory dist
```
打开 `http://localhost:8080`，确认：编辑器加载、无 turnstile 报错、点 Share 能创建（前端 API 指向需通过 Caddy 或临时把 fetch 指向 127.0.0.1:3000）。

> 前端与后端跨域：开发时 vite proxy 已处理；本冒烟测试若 CORS 报错，确认 `corsMiddleware` 仍 `Allow-Origin: *`（已在 security.ts，未改）。

- [ ] **Step 7: 最终提交（如有遗漏修复）**

```bash
git status
# 若有改动：
git add -A && git commit -m "fix: address issues found in end-to-end verification"
```

---

## Self-Review 记录

**1. Spec coverage（逐条对照 spec）：**
- §3.1 文件清单 10 项 → Task 1-9 全覆盖 ✓
- §3.2 PG schema + 4 方法 → Task 2 ✓
- §3.3 Redis 原子限流（修 TOCTOU）→ Task 3 ✓
- §3.4 读缓存 TTL → Task 3 + Task 4（cachePaste 用 EX）✓
- §3.5 删 captcha → Task 6/7/8/10 ✓
- §4 前端移除 Turnstile 6 文件 → Task 10 ✓
- §5.1 静态资源宿主机构建 → Task 12 README ✓
- §5.3 Dockerfile + compose → Task 11 ✓
- §5.4 node-cron → Task 9 ✓
- §6 env 映射 → Task 1（env.ts）+ Task 11（.env.example）✓

**2. 占位符扫描：** 无 TBD/TODO/"add error handling" 等。每步含具体代码 ✓

**3. 类型一致性：**
- `pg.insertPaste` 参数对象 → `createPaste` 调用一致 ✓
- `checkRateLimit(ip)` 签名（middleware → service → redis）一致 ✓
- `PasteRow` 字段（id/content/type/language/created_at）跨 pg/redis/service 一致 ✓
- `AppErrorCode` 移除 CAPTCHA_REQUIRED/CONFIG_MISSING 后，error.ts 同步清理（Task 7）✓

**4. 已知需执行时留意：**
- Task 8 Step 2：`getPasteRoute` 里 `!id` 用 `Errors.invalidJson()` 语义勉强，执行时可改回 `c.json({error}, 400)`。
- Task 10 Step 3：modal.ts 改动较大，执行时先读全文再精简，避免破坏 `showLoadingState` 等 editor 依赖的导出。
- Task 12 Step 2：vite proxy 端口需同步改，取决于 vite.config.ts 实际内容。
