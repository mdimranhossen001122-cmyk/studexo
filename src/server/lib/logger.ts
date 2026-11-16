import pino, { type DestinationStream, type Logger } from 'pino';

const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_NAMES = new Set([
  'password',
  'pass',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'signedurl',
  'signeduploadurl',
  'signeddownloadurl',
  'secret',
  'clientsecret',
  'apikey',
  'xapikey',
  'servicerolekey',
  'anonkey',
  'databaseurl',
  'directdatabaseurl',
  'workerdatabaseurl',
  'catalogadmindatabaseurl',
  'dbsslrootcert',
  'connectionstring',
  'authorization',
  'cookie',
  'setcookie',
  'referer',
  'xsupabaseauth',
  'geminapikey',
  'geminiapikey',
  'supabaseservicerolekey',
  'supabaseanonkey',
]);

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(normalizeKeyName(key));
}

export function sanitizeStringValue(input: string): string {
  let sanitized = input;
  // Redact embedded database credentials in postgres:// or postgresql:// URIs
  sanitized = sanitized.replace(
    /\b(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s/]+)@/gi,
    '$1[REDACTED]:[REDACTED]@',
  );
  // Redact Bearer tokens
  sanitized = sanitized.replace(/\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
  // Redact sensitive query parameters if present in any string URL
  sanitized = sanitized.replace(
    /([?&](?:token|access_token|refresh_token|id_token|signedUrl|signed_url|signedUploadUrl|signedDownloadUrl|sig|signature|apikey|api_key|secret|key|code|password)=)([^&\s#]+)/gi,
    '$1[REDACTED]',
  );
  // Redact Supabase Storage signed object URLs
  sanitized = sanitized.replace(
    /https?:\/\/[^\s"'`]+\/storage\/v1\/object\/sign\/[^\s"'`]+/gi,
    REDACTED,
  );
  return sanitized;
}

const MAX_LOG_DEPTH = 12;

export function sanitizeLogValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth: number = 0,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeStringValue(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= MAX_LOG_DEPTH) {
    return '[MAX_DEPTH]';
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    if (value instanceof Error) {
      const sanitizedError: Record<string, unknown> = {
        type: value.name,
        message: sanitizeStringValue(value.message),
      };
      if (value.stack) {
        sanitizedError.stack = sanitizeStringValue(value.stack);
      }
      for (const [k, v] of Object.entries(value)) {
        sanitizedError[k] = isSensitiveKey(k)
          ? REDACTED
          : sanitizeLogValue(v, seen, depth + 1);
      }
      return sanitizedError;
    }

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeLogValue(item, seen, depth + 1));
    }

    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        output[k] = REDACTED;
      } else {
        output[k] = sanitizeLogValue(v, seen, depth + 1);
      }
    }
    return output;
  }

  return String(value);
}

export function createLogger(
  level: string = 'info',
  destination?: DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: 'studexo-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'req.headers.referer',
        'res.headers["set-cookie"]',
      ],
      censor: REDACTED,
    },
    hooks: {
      logMethod(inputArgs, method) {
        const sanitizedArgs = inputArgs.map((arg) => {
          if (typeof arg === 'string') {
            return sanitizeStringValue(arg);
          }
          if (arg !== null && typeof arg === 'object') {
            try {
              return sanitizeLogValue(arg);
            } catch {
              return { sanitizationError: 'Log payload could not be serialized safely' };
            }
          }
          return arg;
        });
        return method.apply(this, sanitizedArgs as Parameters<typeof method>);
      },
    },
  };

  return destination ? pino(options, destination) : pino(options);
}
