# Studexo Environment Configuration

Environment variables are validated at server startup in `src/server/config/env.ts` using Zod (`parseEnv`). Empty strings (`""`) are normalized to `undefined` for optional variables, while malformed non-empty values fail fast on boot.

## Variable Groups

### 1. Application Runtime (Core)
| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development \| test \| production` |
| `PORT` | `3000` | HTTP listen port (`PORT` injected by Cloud Run / platform) |
| `APP_URL` | *(optional)* | Public origin URL added automatically to CORS allowlist (and enables `upgrade-insecure-requests` in production CSP when `https://`) |
| `ALLOWED_ORIGINS` | *(optional)* | Comma-separated extra allowed CORS origins |
| `CSP_FRAME_ANCESTORS` | *(optional)* | Comma-separated explicit `https://` origins allowed in CSP `frame-ancestors` in production (wildcards rejected; defaults to `'none'` when unset) |
| `TRUST_PROXY_HOPS` | `1` | Immediate reverse proxy hop count (`0` disables; never `true`) |
| `LOG_LEVEL` | `info` (`silent` in `test`) | Pino log verbosity |

### 2. Optional Database & Worker Isolation (Server-Only)
| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(optional)* | PostgreSQL Supavisor transaction pooler URI (`:6543`, `studexo_app`) for runtime API Drizzle queries (`prepare: false`) |
| `DIRECT_DATABASE_URL` | *(migration-required)* | Direct/session PostgreSQL URI (`:5432`, `studexo_migrator`) consumed exclusively by `db:migrate` (`src/server/db/migrate.ts` + `parseMigrationEnv()`, enforcing verified TLS + `DB_SSL_ROOT_CERT`); excluded from `AppEnv`/`parseEnv()` and API/worker startup |
| `WORKER_DATABASE_URL` | *(worker-required)* | Dedicated background worker PostgreSQL URI (`studexo_purge_worker`, `prepare: false`); ignored by API startup, required fail-closed via `parseWorkerEnv()` for `npm run build:worker` / `npm run start:worker` |
| `WORKER_DB_POOL_MAX` | `2` | Maximum worker pool connections (`1..10`) |
| `DB_SSL_ROOT_CERT` | *(optional)* | PEM-encoded X.509 CA bundle for PostgreSQL TLS certificate verification across API, worker, and `db:migrate` |
| `DB_POOL_MAX` | `5` | Maximum runtime API pool connections (`1..20`) |
| `DB_IDLE_TIMEOUT_SECONDS` | `20` | Idle connection timeout in seconds (`5..300`) |
| `DB_CONNECT_TIMEOUT_SECONDS` | `10` | Connection acquisition timeout in seconds (`2..60`) |

Note: `studexo_catalog_admin` remains `NOLOGIN` and `CATALOG_ADMIN_DATABASE_URL` is intentionally deferred until the catalog administration runtime and reference ingestion pipeline are implemented. In `NODE_ENV=production`, insecure TLS parameters (including `sslmode=disable`, `allow`, `prefer`, and `require`) are rejected so certificate and hostname verification remain active across API, worker, and migration tooling.

### 3. Optional Supabase (Server-Only + Public Client)
| Variable | Exposure | Purpose |
|---|---|---|
| `SUPABASE_URL` | Server-only | Supabase project API URL (optional on API; **required fail-closed** in `parseWorkerEnv()`, HTTPS mandatory in production) |
| `SUPABASE_ANON_KEY` | Server-only | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Worker-only secret** | Privileged admin key (bypasses RLS; excluded from `AppEnv`/`parseEnv()`, **required fail-closed** in `parseWorkerEnv()` for worker Storage & Auth Admin APIs; never expose to client or API) |
| `VITE_SUPABASE_URL` | Client-exposed | Public browser Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Client-exposed | Public browser publishable/anon key (safe only with RLS) |

### 4. Optional Gemini AI (Server-Only)
| Variable | Exposure | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | **Server-only secret** | Used exclusively by server-side `@google/genai` orchestration |

## Readiness Behavior

- `GET /api/health` remains database-independent (`200 OK`) so liveness probes never trigger DB connections.
- `GET /api/ready` runs a bounded `SELECT 1` probe against `DATABASE_URL` and returns HTTP `200` (`status: 'ok'`, `database.connected: true`) only when configured and reachable, and HTTP `503` (`status: 'degraded'`, `database.connected: false`) when unconfigured, unreachable, or timed out—without leaking URLs, credentials, or SQL error details.
