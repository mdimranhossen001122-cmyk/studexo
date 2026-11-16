# Studexo Security Baseline (Phase 8B.1.2)

This document records the active security controls hardened in Phase 8B.1.2 and the additional safeguards scheduled for Phase 8B.2+.

## Implemented Controls (Phase 8B.1.2)

1. **HTTP Security Headers & CSP Modes (`helmet`):**
   - `x-powered-by` is disabled.
   - **Development Preview (`NODE_ENV !== 'production'`):** `contentSecurityPolicy: false` and `frameguard: false` (`crossOriginEmbedderPolicy: false`) so Vite dev scripts and AI Studio's preview iframe work cleanly without weakening production headers.
   - **Standalone Production (`NODE_ENV === 'production'`, `CSP_FRAME_ANCESTORS` unset):** Enables restrictive CSP (`default-src 'self'`, `script-src 'self'`, `script-src-attr 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`) alongside `X-Frame-Options: DENY`.
   - **Trusted Embedded Production (`NODE_ENV === 'production'`, `CSP_FRAME_ANCESTORS` set):** Accepts only explicit, validated `https://` origins (wildcards like `https://*.google.com`, paths, and non-HTTPS schemes are rejected at startup) and omits `X-Frame-Options` so browsers enforce the explicit `frame-ancestors` allowlist.
   - **Deliberate `upgrade-insecure-requests`:** Emitted in production CSP only when `APP_URL` uses `https://`, so local HTTP production smoke tests are not broken by forced HTTPS asset upgrades.
2. **Strict CORS Allowlist (`cors`):**
   - Only normalized origins from `APP_URL`, `ALLOWED_ORIGINS`, and (outside production) `http://localhost:<PORT>` / `http://127.0.0.1:<PORT>` are permitted.
   - Unrecognized `Origin` headers receive `403 CORS_ORIGIN_DENIED` on both regular and `OPTIONS` preflight requests.
3. **Request Correlation & Early Middleware Ordering:**
   - `assignRequestId` and `createRequestCompletionLogger` execute before `helmet`, `cors`, and body parsers (`express.json` / `express.urlencoded`), guaranteeing every request—including `403 CORS`, `413 PAYLOAD_TOO_LARGE`, and `400 INVALID_JSON`—receives a validated/generated `X-Request-Id` header, matching `error.requestId`, and a single structured completion log.
4. **Proxy Configuration:**
   - `app.set('trust proxy', TRUST_PROXY_HOPS)` defaults to `1` hop (Nginx / Cloud Run load balancer) and never uses `trust proxy: true`, preventing `X-Forwarded-For` IP spoofing against rate limits.
5. **Payload Limits & Rate Limiting:**
   - `express.json` and `express.urlencoded` enforce a `100kb` body limit (`413 PAYLOAD_TOO_LARGE`).
   - `/api/*` routes (excluding `/api/health` liveness probes) enforce `express-rate-limit` (`120` requests / 15 min per IP in non-test environments).
6. **Deep Log Sanitization & Path-Only HTTP Logging (`pino`):**
   - Recursive sanitization via Pino `hooks.logMethod` redacts sensitive keys (`password`, `token`, `accessToken`, `refreshToken`, `signedUrl`, `signedUploadUrl`, `signedDownloadUrl`, `secret`, `apiKey`, `serviceRoleKey`, `databaseUrl`, `connectionString`, `authorization`, `cookie`, `set-cookie`, `x-api-key`, `referer`) at **arbitrary nesting depths** and inside arrays/errors, plus regex masking for `postgres://` credentials, `Bearer` tokens, signed Storage URLs, and sensitive query parameters.
   - HTTP and error logs record pathname-only paths (`getSafePath(req)`, never `req.originalUrl` with raw query strings) and omit raw `req`/`res` objects and `referer` headers.
7. **Centralized Error Serialization:**
   - Production `5xx` responses mask internal messages and omit stack traces/details while preserving `ApiErrorPayload`.
8. **Client/Server Isolation:**
   - Separate TS configs (`tsconfig.client.json` / `tsconfig.server.json`), ESLint `no-restricted-imports` rules, and scoped Vite aliases prevent server modules or secrets from entering browser bundles.

## Deferred Controls (Phase 8B.2+)

- Supabase JWT authentication middleware and role-based access control (RBAC).
- Per-record PostgreSQL ownership predicates in Drizzle (essential because server Postgres connections bypass Supabase RLS).
- Supabase RLS policies for client/Storage access.
- Private Supabase Storage bucket with short-lived signed upload/download URLs and MIME/size validation.
- Per-user rate limiting and token quotas on `/api/ai/*` Gemini endpoints.
