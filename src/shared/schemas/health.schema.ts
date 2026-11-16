import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('studexo-api'),
  environment: z.enum(['development', 'test', 'production']),
  timestamp: z.string(),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  runtime: z.object({
    configured: z.boolean(),
    nodeVersion: z.string(),
  }),
  integrations: z.object({
    database: z.object({
      configured: z.boolean(),
      connected: z.boolean(),
    }),
    supabase: z.object({
      configured: z.boolean(),
      verified: z.literal(false),
    }),
    gemini: z.object({
      configured: z.boolean(),
      verified: z.literal(false),
    }),
  }),
  timestamp: z.string(),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;
