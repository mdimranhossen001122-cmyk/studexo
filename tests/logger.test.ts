import { PassThrough } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import { parseEnv } from '../src/server/config/env';
import { createLogger } from '../src/server/lib/logger';
import { AppError } from '../src/server/middleware/errorHandler';

function createCapturedLogger(level: string = 'info') {
  const chunks: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf8'));
  });
  const logger = createLogger(level, stream);
  return {
    logger,
    getOutput: () => chunks.join(''),
    getParsedLogs: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('Pino logger deep sanitization and query-string protection', () => {
  it('redacts top-level, deeply nested, signed URL, credential, and header secrets while keeping operational fields', () => {
    const capture = createCapturedLogger('info');

    capture.logger.info(
      {
        requestId: 'req-op-12345',
        statusCode: 200,
        durationMs: 12.34,
        password: 'SECRET_TOP_PASSWORD',
        token: 'SECRET_TOP_TOKEN',
        signedUrl: 'https://proj.supabase.co/storage/v1/object/sign/docs/file.pdf?token=TOP_SIGNED',
        signedUploadUrl: 'https://proj.supabase.co/upload/signed?token=UPLOAD_SIG',
        signedDownloadUrl: 'https://proj.supabase.co/download/signed?token=DOWNLOAD_SIG',
        connectionString: 'postgresql://dbuser:SECRET_CONN_PW@db.example.com:6543/postgres',
        DATABASE_URL: 'postgres://admin:SECRET_DB_PW@localhost:5432/studexo',
        DIRECT_DATABASE_URL: 'postgres://admin:SECRET_DIRECT_PW@localhost:5432/studexo',
        WORKER_DATABASE_URL: 'postgres://worker:SECRET_WORKER_PW@localhost:5432/studexo',
        DB_SSL_ROOT_CERT: 'SECRET_PEM_CERT_BODY',
        SUPABASE_SERVICE_ROLE_KEY: 'SECRET_SRK_VALUE',
        GEMINI_API_KEY: 'SECRET_GEMINI_VALUE',
        req: {
          headers: {
            authorization: 'Bearer SECRET_AUTH_JWT',
            cookie: 'session=SECRET_COOKIE_VAL',
            'x-api-key': 'SECRET_HEADER_API_KEY',
            referer: 'https://accounts.example.com/callback?token=SECRET_REFERER_TOK',
          },
        },
        res: {
          headers: {
            'set-cookie': ['session=SECRET_SET_COOKIE; HttpOnly'],
          },
        },
        deep: {
          layer1: {
            layer2: {
              layer3: {
                password: 'SECRET_DEEP_PASSWORD',
                accessToken: 'SECRET_DEEP_ACCESS',
                refreshToken: 'SECRET_DEEP_REFRESH',
                secret: 'SECRET_DEEP_SECRET',
                apiKey: 'SECRET_DEEP_API_KEY',
                serviceRoleKey: 'SECRET_DEEP_SERVICE_ROLE',
                databaseUrl: 'postgres://u:SECRET_DEEP_DB@host/db',
                signedUrl: 'https://proj.supabase.co/storage/v1/object/sign/a/b.pdf?token=DEEP_SIG',
                safeField: 'visible-metadata',
              },
            },
          },
        },
        errorDetails: new Error(
          'Failed connecting to postgres://dbu:SECRET_ERR_DB@host:5432/db with Bearer SECRET_ERR_BEARER and https://proj.supabase.co/storage/v1/object/sign/bucket/doc.pdf?token=SECRET_ERR_SIG',
        ),
      },
      'Operational event completed with Bearer SECRET_MSG_BEARER',
    );

    const raw = capture.getOutput();

    const forbiddenSecrets = [
      'SECRET_TOP_PASSWORD',
      'SECRET_TOP_TOKEN',
      'TOP_SIGNED',
      'UPLOAD_SIG',
      'DOWNLOAD_SIG',
      'SECRET_CONN_PW',
      'SECRET_DB_PW',
      'SECRET_DIRECT_PW',
      'SECRET_WORKER_PW',
      'SECRET_PEM_CERT_BODY',
      'SECRET_SRK_VALUE',
      'SECRET_GEMINI_VALUE',
      'SECRET_AUTH_JWT',
      'SECRET_COOKIE_VAL',
      'SECRET_HEADER_API_KEY',
      'SECRET_REFERER_TOK',
      'SECRET_SET_COOKIE',
      'SECRET_DEEP_PASSWORD',
      'SECRET_DEEP_ACCESS',
      'SECRET_DEEP_REFRESH',
      'SECRET_DEEP_SECRET',
      'SECRET_DEEP_API_KEY',
      'SECRET_DEEP_SERVICE_ROLE',
      'SECRET_DEEP_DB',
      'DEEP_SIG',
      'SECRET_ERR_DB',
      'SECRET_ERR_BEARER',
      'SECRET_ERR_SIG',
      'SECRET_MSG_BEARER',
    ];

    for (const secret of forbiddenSecrets) {
      expect(raw).not.toContain(secret);
    }

    const [entry] = capture.getParsedLogs();
    expect(entry).toBeDefined();
    expect(entry?.requestId).toBe('req-op-12345');
    expect(entry?.statusCode).toBe(200);
    expect(entry?.durationMs).toBe(12.34);
    expect(entry?.password).toBe('[REDACTED]');
    expect(entry?.token).toBe('[REDACTED]');
    expect(entry?.signedUrl).toBe('[REDACTED]');
    expect(
      ((entry?.deep as Record<string, unknown>)?.layer1 as Record<string, unknown>)?.layer2,
    ).toMatchObject({
      layer3: {
        password: '[REDACTED]',
        accessToken: '[REDACTED]',
        refreshToken: '[REDACTED]',
        secret: '[REDACTED]',
        apiKey: '[REDACTED]',
        serviceRoleKey: '[REDACTED]',
        databaseUrl: '[REDACTED]',
        signedUrl: '[REDACTED]',
        safeField: 'visible-metadata',
      },
    });
  });

  it('never writes query-string tokens or signed URLs into HTTP completion or error logs', async () => {
    const capture = createCapturedLogger('info');
    const env = parseEnv({
      NODE_ENV: 'production',
      APP_URL: 'https://studexo.example.com',
    });
    const { app, clientRouter } = createApp({ env, logger: capture.logger });

    clientRouter.get('/explode', () => {
      throw new AppError(500, 'UPSTREAM_ERR', 'Database call failed');
    });

    const degradedReadyRes = await request(app).get(
      '/api/ready?token=QUERY_SECRET_TOKEN&signedUrl=https://storage.example/s?sig=QUERY_SIG',
    );
    expect(degradedReadyRes.status).toBe(503);

    const notFoundRes = await request(app).get(
      '/api/missing-route?token=NOTFOUND_SECRET_TOKEN&signedUrl=NOTFOUND_SIGNED_URL',
    );
    expect(notFoundRes.status).toBe(404);
    expect(JSON.stringify(notFoundRes.body)).not.toContain('NOTFOUND_SECRET_TOKEN');
    expect(JSON.stringify(notFoundRes.body)).not.toContain('NOTFOUND_SIGNED_URL');

    const errRes = await request(app).get(
      '/explode?token=EXPLODE_SECRET_TOKEN&signedUrl=EXPLODE_SIGNED_URL',
    );
    expect(errRes.status).toBe(500);

    const rawLogs = capture.getOutput();
    expect(rawLogs).not.toContain('QUERY_SECRET_TOKEN');
    expect(rawLogs).not.toContain('QUERY_SIG');
    expect(rawLogs).not.toContain('NOTFOUND_SECRET_TOKEN');
    expect(rawLogs).not.toContain('NOTFOUND_SIGNED_URL');
    expect(rawLogs).not.toContain('EXPLODE_SECRET_TOKEN');
    expect(rawLogs).not.toContain('EXPLODE_SIGNED_URL');

    const logs = capture.getParsedLogs();
    const readyLog = logs.find(
      (l) => (l.req as Record<string, unknown> | undefined)?.path === '/api/ready',
    );
    expect(readyLog).toBeDefined();
    expect(readyLog?.level).toBe(40);
    expect(readyLog?.requestId).toBe(degradedReadyRes.headers['x-request-id']);
    expect((readyLog?.res as Record<string, unknown>)?.statusCode).toBe(503);
    expect(typeof readyLog?.durationMs).toBe('number');

    const explodeLog = logs.find(
      (l) => (l.req as Record<string, unknown> | undefined)?.path === '/explode',
    );
    expect(explodeLog?.level).toBe(50);
  });
});
