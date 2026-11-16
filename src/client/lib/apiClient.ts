import { healthResponseSchema, readyResponseSchema, type HealthResponse, type ReadyResponse } from '@shared/schemas/health.schema';

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }
  const json: unknown = await response.json();
  return healthResponseSchema.parse(json);
}

export async function fetchReadiness(): Promise<ReadyResponse> {
  const response = await fetch('/api/ready', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Readiness check failed with status ${response.status}`);
  }
  const json: unknown = await response.json();
  return readyResponseSchema.parse(json);
}
