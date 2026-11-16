# Studexo — Modular Monolith Foundation

Studexo is a global higher-education admissions and guidance platform initially targeting students in Bangladesh and India.

> **Current Phase:** Phase 8B.2A (Drizzle ORM & PostgreSQL Database Foundation). Schema definitions, lazy `postgres.js` pool configuration, and initial SQL migration (`drizzle/0000_init_studexo_foundation.sql`) are in place without live database connectivity or executed migrations.

## Technology Stack

- **Runtime:** Node.js `v22` (`>=22.22.0 <23`)
- **Package Manager & Lockfile:** Bun (`bun.lock` only; never commit `package-lock.json`)
- **Frontend:** React `19`, Vite `8`, Tailwind CSS `4`, TypeScript `6.0.3`
- **Backend:** Express `4`, Drizzle ORM `0.45.4`, `postgres.js` `3.4.9`, Zod `4`, Pino `10`, Helmet `8`, CORS, `express-rate-limit`
- **Quality & Testing:** ESLint `10` + `typescript-eslint`, separate client/server `tsc --noEmit`, Vitest `5`, Supertest `7`

## Development Workflow

```bash
# Install dependencies (Bun is the sole package manager)
bun install

# Start unified Express + Vite 8 middleware dev server on PORT (default 3000)
npm run dev

# Type-check client and server separately
npm run typecheck

# Run ESLint across client, server, and shared modules
npm run lint

# Run unit and API tests
npm test

# Build production client (dist/client) and server (dist/server.js)
npm run build

# Start production Node.js server
npm start
```

## Initial API Endpoints

- `GET /api/health` — Application liveness check (`200 OK`).
- `GET /api/ready` — Configuration readiness report (`runtime.configured` plus boolean flags for optional integrations; never fabricates DB/Supabase connections or exposes secrets).

## Pending Integrations (Phase 8B.2+)

- **Supabase PostgreSQL + Drizzle ORM (`postgres@3.4.x`):** Pooled runtime connection (`prepare: false` for Supavisor transaction pooler `:6543`) and migration pipeline (`:5432`).
- **Supabase Auth & Private Storage:** Server-side JWT verification, RBAC guards, ownership checks, and short-lived signed upload/download URLs.
- **Gemini Server-Side Orchestration:** `@google/genai` integration behind authenticated, rate-limited `/api/*` routes with Zod-validated structured outputs.
- **Student Frontend Shell:** Routing (`react-router`), forms (`react-hook-form`), design system tokens, and regional performance optimizations.
