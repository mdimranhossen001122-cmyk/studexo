import {
  authMeResponseSchema,
  authSyncRequestSchema,
  authSyncResponseSchema,
  type AuthMeResponse,
  type AuthSyncRequest,
  type AuthSyncResponse,
} from '@shared/schemas/auth.schema';
import {
  healthResponseSchema,
  readyResponseSchema,
  type HealthResponse,
  type ReadyResponse,
} from '@shared/schemas/health.schema';
import {
  studentProfileResponseSchema,
  studentProfileUpdateRequestSchema,
  type StudentProfileResponse,
  type StudentProfileUpdateRequest,
} from '@shared/schemas/studentProfile.schema';
import type { ApiErrorPayload } from '@shared/types/api';

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly details?: unknown;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  }) {
    super(options.message);
    this.name = 'ApiClientError';
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export function isApiClientError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError;
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const errorObj = (value as { error?: unknown }).error;
  if (!errorObj || typeof errorObj !== 'object') {
    return false;
  }
  const candidate = errorObj as { code?: unknown; message?: unknown };
  return typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

export async function parseApiErrorResponse(response: Response): Promise<ApiClientError> {
  const headerRequestId = response.headers.get('x-request-id') ?? undefined;
  let parsedBody: unknown;

  try {
    parsedBody = await response.json();
  } catch {
    parsedBody = null;
  }

  if (isApiErrorPayload(parsedBody)) {
    return new ApiClientError({
      status: response.status,
      code: parsedBody.error.code,
      message: parsedBody.error.message,
      requestId: parsedBody.error.requestId ?? headerRequestId,
      details: parsedBody.error.details,
    });
  }

  const fallbackCode =
    response.status === 401
      ? 'AUTH_UNAUTHENTICATED'
      : response.status === 403
        ? 'AUTH_FORBIDDEN'
        : response.status === 404
          ? 'NOT_FOUND'
          : response.status === 429
            ? 'RATE_LIMIT_EXCEEDED'
            : response.status >= 500
              ? 'SERVICE_UNAVAILABLE'
              : 'REQUEST_FAILED';

  return new ApiClientError({
    status: response.status,
    code: fallbackCode,
    message: `Request failed with HTTP status ${response.status}.`,
    requestId: headerRequestId,
  });
}

function requireBearerAccessToken(accessToken: string): string {
  const trimmed = accessToken.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    throw new ApiClientError({
      status: 401,
      code: 'AUTH_TOKEN_MISSING',
      message: 'A valid session access token is required.',
    });
  }
  return trimmed;
}

export async function fetchHealth(fetcher: typeof fetch = fetch): Promise<HealthResponse> {
  const response = await fetcher('/api/health', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }
  const json: unknown = await response.json();
  return healthResponseSchema.parse(json);
}

export async function fetchReadiness(fetcher: typeof fetch = fetch): Promise<ReadyResponse> {
  const response = await fetcher('/api/ready', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Readiness check failed with status ${response.status}`);
  }
  const json: unknown = await response.json();
  return readyResponseSchema.parse(json);
}

export async function syncAuthSession(
  accessToken: string,
  preferences?: AuthSyncRequest,
  fetcher: typeof fetch = fetch,
): Promise<AuthSyncResponse> {
  const bearerToken = requireBearerAccessToken(accessToken);
  const validatedBody = authSyncRequestSchema.parse(preferences ?? {});

  const response = await fetcher('/api/auth/sync', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    cache: 'no-store',
    body: JSON.stringify(validatedBody),
  });

  if (!response.ok) {
    throw await parseApiErrorResponse(response);
  }

  const json: unknown = await response.json();
  return authSyncResponseSchema.parse(json);
}

export async function fetchCurrentUser(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<AuthMeResponse> {
  const bearerToken = requireBearerAccessToken(accessToken);

  const response = await fetcher('/api/auth/me', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw await parseApiErrorResponse(response);
  }

  const json: unknown = await response.json();
  return authMeResponseSchema.parse(json);
}

export async function fetchStudentProfile(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<StudentProfileResponse> {
  const bearerToken = requireBearerAccessToken(accessToken);

  const response = await fetcher('/api/student/profile', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw await parseApiErrorResponse(response);
  }

  const json: unknown = await response.json();
  return studentProfileResponseSchema.parse(json);
}

export async function saveStudentProfile(
  accessToken: string,
  payload: StudentProfileUpdateRequest,
  fetcher: typeof fetch = fetch,
): Promise<StudentProfileResponse> {
  const bearerToken = requireBearerAccessToken(accessToken);
  const validatedBody = studentProfileUpdateRequestSchema.parse(payload);

  const response = await fetcher('/api/student/profile', {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
    cache: 'no-store',
    body: JSON.stringify(validatedBody),
  });

  if (!response.ok) {
    throw await parseApiErrorResponse(response);
  }

  const json: unknown = await response.json();
  return studentProfileResponseSchema.parse(json);
}
