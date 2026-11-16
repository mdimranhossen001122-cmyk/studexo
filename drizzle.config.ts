import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema/index.ts',
  out: './drizzle',
  schemaFilter: ['studexo'],
  migrations: {
    schema: 'drizzle',
    table: '__drizzle_migrations',
  },
  strict: true,
  verbose: true,
  dbCredentials: {
    // Migrations require a direct/session PostgreSQL connection (port 5432),
    // never the Supavisor transaction pooler URL. Live execution uses `npm run db:migrate`
    // (`src/server/db/migrate.ts`) so verified TLS (`DB_SSL_ROOT_CERT`) and pre-created
    // `drizzle` tracking schema privilege boundaries are strictly enforced.
    url: process.env.DIRECT_DATABASE_URL ?? '',
  },
});
