# Studexo Architecture (Modular Monolith)

Studexo follows a **single-deployment modular monolith** design built for Google AI Studio development and Google Cloud Run production hosting.

## Directory Boundaries

```text
/
├── server.ts                 # Root server entrypoint: boots Express + Vite (dev) or static dist/client (prod) + graceful shutdown
├── src/
│   ├── client/               # Browser-only React 19 SPA (tsconfig.client.json)
│   │   ├── app/              # App root & providers
│   │   ├── components/       # Reusable UI primitives & ErrorBoundary
│   │   ├── features/         # Domain UI feature modules (future phases)
│   │   ├── layouts/          # Page/navigation shells
│   │   ├── lib/              # Browser-safe utilities & API client
│   │   └── styles/           # Tailwind CSS v4 entry
│   ├── server/               # Node.js-only Express backend (tsconfig.server.json)
│   │   ├── app.ts            # Pure createApp() factory separated from listen()
│   │   ├── config/           # Zod environment validation
│   │   ├── db/               # Drizzle ORM schema (studexo schema), lazy postgres.js client, migration config
│   │   ├── lib/              # Pino logger & shared server helpers
│   │   ├── middleware/       # Security, request logging, centralized error handling
│   │   └── modules/          # Domain vertical slices (health in 8B.1; auth, students, ai in 8B.2+)
│   └── shared/               # Pure environment-agnostic Zod schemas & TS types
│       ├── schemas/
│       └── types/
└── tests/                    # Vitest + Supertest automated test suite
```

## Boundary Enforcement

1. **Separate TypeScript Configs:**
   - `tsconfig.client.json` includes only `src/client` and `src/shared` with `DOM` + `vite/client` types.
   - `tsconfig.server.json` includes `server.ts`, `src/server`, `src/shared`, and `tests` with `node` types.
2. **ESLint `no-restricted-imports` Rules:**
   - `src/client/**` is blocked from importing `src/server/**`, `server.ts`, `postgres`, `drizzle-orm`, `@google/genai`, `express`, `dotenv`, `pino`, `helmet`, `cors`, and `express-rate-limit`.
   - `src/server/**` is blocked from importing `src/client/**`.
   - `src/shared/**` must remain pure (no client or server imports).
3. **Vite Alias Isolation:**
   - `vite.config.ts` maps `@` -> `src/client` and `@shared` -> `src/shared` only.

## Request Lifecycle

1. `configureProxyTrust` sets bounded `trust proxy` hop count (`1` by default).
2. `helmet` & `cors` enforce security headers and explicit origin allowlists.
3. `express.json` / `express.urlencoded` enforce a `100kb` payload limit.
4. `createRequestLogger` attaches `X-Request-Id` and logs structured metadata via Pino.
5. `/api` routes pass through `express-rate-limit` (skipping `/api/health` liveness probes), route handlers, and `apiNotFoundHandler`.
6. Non-API requests pass to `clientRouter` (`vite.middlewares` in dev; `dist/client` static + SPA fallback in production).
7. `createErrorHandler` serializes all errors into a consistent JSON envelope without leaking internals in production.
