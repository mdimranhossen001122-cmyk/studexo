import crypto from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { AuthError } from '../src/shared/types/auth';
import {
  extractVerifiedIdentities,
  LocalJwtVerifier,
  mapSupabaseProvider,
  MockTokenVerifier,
  SupabaseTokenVerifier,
} from '../src/server/modules/auth/tokenVerifier';

describe('Phase 8B.5A Milestone 1 — Cryptographic Token Verifier & Claims Engine', () => {
  const TEST_SECRET = 'super-secret-jwt-signing-key-for-studexo-auth-tests-32b';
  const VALID_USER_ID = '00000000-0000-4000-8000-000000000001';
  const VALID_EMAIL = 'student@studexo.example.com';

  // Helper to generate real signed HS256 JWTs using node:crypto
  function createSignedHs256Token(
    payloadOverrides: Record<string, unknown> = {},
    headerOverrides: Record<string, unknown> = {},
    secret: string = TEST_SECRET,
  ): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = {
      alg: 'HS256',
      typ: 'JWT',
      ...headerOverrides,
    };
    const payload = {
      sub: VALID_USER_ID,
      email: VALID_EMAIL,
      aud: 'authenticated',
      role: 'authenticated',
      iat: nowSec,
      exp: nowSec + 3600,
      iss: 'https://example.supabase.co/auth/v1',
      ...payloadOverrides,
    };

    const rawHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
    const rawPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    let signature = '';
    if (header.alg === 'HS256') {
      signature = crypto
        .createHmac('sha256', secret)
        .update(`${rawHeader}.${rawPayload}`)
        .digest('base64url');
    } else if (header.alg !== 'none') {
      signature = Buffer.from('mock-sig').toString('base64url');
    }

    return `${rawHeader}.${rawPayload}.${signature}`;
  }

  describe('LocalJwtVerifier (Real Cryptographic HS256 Verification)', () => {
    const verifier = new LocalJwtVerifier({
      jwtSecret: TEST_SECRET,
      expectedAudience: 'authenticated',
      expectedIssuer: 'https://example.supabase.co/auth/v1',
    });

    it('successfully verifies a valid cryptographic HS256 token and returns sanitized claims without raw token', () => {
      const token = createSignedHs256Token({
        user_metadata: { full_name: 'Test Student' },
        app_metadata: { provider: 'email' },
      });

      const claims = verifier.verify(token);

      expect(claims.sub).toBe(VALID_USER_ID);
      expect(claims.email).toBe(VALID_EMAIL);
      expect(claims.aud).toBe('authenticated');
      expect(claims.role).toBe('authenticated');
      expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(claims.userMetadata).toEqual({ full_name: 'Test Student' });
      expect(claims.appMetadata).toEqual({ provider: 'email' });

      // Ensure no raw token is retained in claims object
      expect((claims as unknown as Record<string, unknown>).rawToken).toBeUndefined();
      expect((claims as unknown as Record<string, unknown>).token).toBeUndefined();
    });

    it('rejects token when signature is signed with an incorrect secret', () => {
      const wrongSecretToken = createSignedHs256Token({}, {}, 'completely-wrong-secret-key-32-bytes');

      expect(() => verifier.verify(wrongSecretToken)).toThrowError(AuthError);
      try {
        verifier.verify(wrongSecretToken);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_INVALID_SIGNATURE');
        expect(authErr.statusCode).toBe(401);
      }
    });

    it('rejects token when signature bytes have been tampered with', () => {
      const validToken = createSignedHs256Token();
      const segments = validToken.split('.');
      const header = segments[0]!;
      const payload = segments[1]!;
      const sig = segments[2]!;
      const tamperedSig = sig.slice(0, -2) + (sig.endsWith('A') ? 'B' : 'A');
      const tamperedToken = `${header}.${payload}.${tamperedSig}`;

      expect(() => verifier.verify(tamperedToken)).toThrowError(AuthError);
      try {
        verifier.verify(tamperedToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_SIGNATURE');
      }
    });

    it('rejects token when payload has been tampered with after signing', () => {
      const validToken = createSignedHs256Token({ sub: VALID_USER_ID, role: 'authenticated' });
      const segments = validToken.split('.');
      const header = segments[0]!;
      const sig = segments[2]!;
      // Tamper payload to elevate role
      const tamperedPayloadObj = {
        sub: VALID_USER_ID,
        email: VALID_EMAIL,
        aud: 'authenticated',
        role: 'admin',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iss: 'https://example.supabase.co/auth/v1',
      };
      const tamperedPayload = Buffer.from(JSON.stringify(tamperedPayloadObj)).toString('base64url');
      const tamperedToken = `${header}.${tamperedPayload}.${sig}`;

      expect(() => verifier.verify(tamperedToken)).toThrowError(AuthError);
      try {
        verifier.verify(tamperedToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_SIGNATURE');
      }
    });

    it('rejects expired tokens (exp in past)', () => {
      const pastSec = Math.floor(Date.now() / 1000) - 100;
      const expiredToken = createSignedHs256Token({
        iat: pastSec - 3600,
        exp: pastSec,
      });

      expect(() => verifier.verify(expiredToken)).toThrowError(AuthError);
      try {
        verifier.verify(expiredToken);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_TOKEN_EXPIRED');
        expect(authErr.statusCode).toBe(401);
      }
    });

    it('strictly rejects tokens with algorithm "none" (algorithm confusion protection)', () => {
      const noneToken = createSignedHs256Token({}, { alg: 'none' });

      expect(() => verifier.verify(noneToken)).toThrowError(AuthError);
      try {
        verifier.verify(noneToken);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_INVALID_ALGORITHM');
        expect(authErr.message).toContain('Unsupported or forbidden');
      }
    });

    it('rejects tokens with unapproved algorithms (e.g. HS512 or arbitrary strings)', () => {
      const unapprovedToken = createSignedHs256Token({}, { alg: 'HS512' });

      expect(() => verifier.verify(unapprovedToken)).toThrowError(AuthError);
      try {
        verifier.verify(unapprovedToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_ALGORITHM');
      }
    });

    it('rejects tokens with mismatched audience claim', () => {
      const wrongAudToken = createSignedHs256Token({ aud: 'public' });

      expect(() => verifier.verify(wrongAudToken)).toThrowError(AuthError);
      try {
        verifier.verify(wrongAudToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_AUDIENCE');
      }
    });

    it('rejects tokens with mismatched issuer claim', () => {
      const wrongIssToken = createSignedHs256Token({ iss: 'https://attacker.example.com/auth/v1' });

      expect(() => verifier.verify(wrongIssToken)).toThrowError(AuthError);
      try {
        verifier.verify(wrongIssToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_ISSUER');
      }
    });

    it('rejects tokens missing email claim', () => {
      const noEmailToken = createSignedHs256Token({ email: undefined });

      expect(() => verifier.verify(noEmailToken)).toThrowError(AuthError);
      try {
        verifier.verify(noEmailToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_EMAIL_REQUIRED');
      }
    });

    it('rejects tokens where sub is not a valid UUID format', () => {
      const badSubToken = createSignedHs256Token({ sub: 'not-a-valid-uuid' });

      expect(() => verifier.verify(badSubToken)).toThrowError(AuthError);
      try {
        verifier.verify(badSubToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_TOKEN');
        expect((err as AuthError).message).toContain('must be a valid UUID');
      }
    });

    it('rejects malformed token strings (not 3 segments or empty)', () => {
      expect(() => verifier.verify('')).toThrowError(/missing or empty/);
      expect(() => verifier.verify('single-string')).toThrowError(/expected 3 segments/);
      expect(() => verifier.verify('two.segments')).toThrowError(/expected 3 segments/);
      expect(() => verifier.verify('four.segments.here.extra')).toThrowError(/expected 3 segments/);
    });
  });

  describe('LocalJwtVerifier (Real Cryptographic RS256 Asymmetric Verification)', () => {
    // Generate real RSA key pair for asymmetric cryptographic testing
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    function createSignedRs256Token(payloadOverrides: Record<string, unknown> = {}): string {
      const nowSec = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', typ: 'JWT' };
      const payload = {
        sub: VALID_USER_ID,
        email: VALID_EMAIL,
        aud: 'authenticated',
        role: 'authenticated',
        iat: nowSec,
        exp: nowSec + 3600,
        ...payloadOverrides,
      };

      const rawHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const rawPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(`${rawHeader}.${rawPayload}`);
      const signature = signer.sign(privateKey, 'base64url');

      return `${rawHeader}.${rawPayload}.${signature}`;
    }

    const rsVerifier = new LocalJwtVerifier({
      publicKey,
      expectedAudience: 'authenticated',
    });

    it('successfully verifies a real RS256 token signed with RSA private key', () => {
      const token = createSignedRs256Token();
      const claims = rsVerifier.verify(token);

      expect(claims.sub).toBe(VALID_USER_ID);
      expect(claims.email).toBe(VALID_EMAIL);
      expect(claims.aud).toBe('authenticated');
    });

    it('rejects RS256 token when signature is verified against a different public key', () => {
      const otherPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const wrongKeyVerifier = new LocalJwtVerifier({
        publicKey: otherPair.publicKey,
        expectedAudience: 'authenticated',
      });

      const token = createSignedRs256Token();
      expect(() => wrongKeyVerifier.verify(token)).toThrowError(AuthError);
      try {
        wrongKeyVerifier.verify(token);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_SIGNATURE');
      }
    });
  });

  describe('LocalJwtVerifier (Real Cryptographic ES256 Elliptic Curve Verification)', () => {
    // Generate real ECDSA P-256 (prime256v1) key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    function createSignedEs256Token(payloadOverrides: Record<string, unknown> = {}): string {
      const nowSec = Math.floor(Date.now() / 1000);
      const header = { alg: 'ES256', typ: 'JWT' };
      const payload = {
        sub: VALID_USER_ID,
        email: VALID_EMAIL,
        aud: 'authenticated',
        role: 'authenticated',
        iat: nowSec,
        exp: nowSec + 3600,
        ...payloadOverrides,
      };

      const rawHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
      const rawPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const signer = crypto.createSign('SHA256');
      signer.update(`${rawHeader}.${rawPayload}`);
      // RFC 7518 specifies IEEE P1363 (64 bytes) for ES256 JWT signatures
      const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url');

      return `${rawHeader}.${rawPayload}.${signature}`;
    }

    const esVerifier = new LocalJwtVerifier({
      publicKey,
      expectedAudience: 'authenticated',
    });

    it('successfully verifies a real ES256 token signed with EC P-256 private key', () => {
      const token = createSignedEs256Token();
      const claims = esVerifier.verify(token);

      expect(claims.sub).toBe(VALID_USER_ID);
      expect(claims.email).toBe(VALID_EMAIL);
      expect(claims.aud).toBe('authenticated');
    });

    it('rejects ES256 token when signature is verified against a different EC public key', () => {
      const otherPair = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const wrongKeyVerifier = new LocalJwtVerifier({
        publicKey: otherPair.publicKey,
        expectedAudience: 'authenticated',
      });

      const token = createSignedEs256Token();
      expect(() => wrongKeyVerifier.verify(token)).toThrowError(AuthError);
      try {
        wrongKeyVerifier.verify(token);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_SIGNATURE');
      }
    });

    it('rejects ES256 token when signature bytes are tampered with', () => {
      const validToken = createSignedEs256Token();
      const segments = validToken.split('.');
      const header = segments[0]!;
      const payload = segments[1]!;
      const sig = segments[2]!;
      const tamperedSig = sig.slice(0, -2) + (sig.endsWith('A') ? 'B' : 'A');
      const tamperedToken = `${header}.${payload}.${tamperedSig}`;

      expect(() => esVerifier.verify(tamperedToken)).toThrowError(AuthError);
      try {
        esVerifier.verify(tamperedToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_SIGNATURE');
      }
    });
  });

  describe('Authoritative Identity Verification (extractVerifiedIdentities)', () => {
    it('successfully extracts verified identity when email_confirmed_at is present', () => {
      const confirmedDate = new Date().toISOString();
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'email' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [
          {
            id: 'ident-1',
            user_id: VALID_USER_ID,
            identity_id: 'ident-id-1',
            provider: 'email',
            identity_data: { email: VALID_EMAIL, email_verified: true },
            created_at: confirmedDate,
          },
        ],
      };

      const result = extractVerifiedIdentities(user);
      expect(result.email).toBe(VALID_EMAIL);
      expect(result.emailConfirmedAt.toISOString()).toBe(new Date(confirmedDate).toISOString());
      expect(result.identities).toHaveLength(1);
      expect(result.identities[0]!).toEqual({
        provider: 'supabase_email',
        providerSubject: VALID_USER_ID,
        emailAtProvider: VALID_EMAIL,
        emailVerified: true,
      });
    });

    it('correctly maps third-party Google OAuth providerSubject from identity.provider_id', () => {
      const googleSub = '10928347102938471';
      const confirmedDate = new Date().toISOString();
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'google' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [
          {
            id: 'ident-google-1',
            user_id: VALID_USER_ID,
            identity_id: 'ident-google-id-1',
            provider: 'google',
            identity_data: {
              provider_id: googleSub,
              email: VALID_EMAIL,
              email_verified: true,
            },
            created_at: confirmedDate,
          },
        ],
      };

      const result = extractVerifiedIdentities(user);
      expect(result.identities[0]!.provider).toBe('google');
      expect(result.identities[0]!.providerSubject).toBe(googleSub);
      expect(result.identities[0]!.emailVerified).toBe(true);
    });

    it('rejects account when email_confirmed_at is null and no verified OAuth identity exists', () => {
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'email' },
        user_metadata: { email_verified: true }, // Client metadata must be ignored!
        aud: 'authenticated',
        created_at: new Date().toISOString(),
        email: VALID_EMAIL,
        email_confirmed_at: null as unknown as string,
        identities: [
          {
            id: 'ident-1',
            user_id: VALID_USER_ID,
            identity_id: 'ident-id-1',
            provider: 'email',
            identity_data: { email: VALID_EMAIL },
            created_at: new Date().toISOString(),
          },
        ],
      };

      expect(() => extractVerifiedIdentities(user)).toThrowError(AuthError);
      try {
        extractVerifiedIdentities(user);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
        expect(authErr.statusCode).toBe(403);
      }
    });

    it('rejects user without primary email address', () => {
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: {},
        user_metadata: {},
        aud: 'authenticated',
        created_at: new Date().toISOString(),
        email: '',
      };

      expect(() => extractVerifiedIdentities(user)).toThrowError(AuthError);
      try {
        extractVerifiedIdentities(user);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_EMAIL_REQUIRED');
      }
    });

    it('accepts GitHub providerSubject from identity_data.sub when provider_id is omitted and ignores internal ident.id', () => {
      const githubId = '84729103';
      const confirmedDate = new Date().toISOString();
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'github' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: confirmedDate,
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [
          {
            id: 'ident-github-internal-record-id',
            user_id: VALID_USER_ID,
            identity_id: '22222222-2222-4222-8222-222222222222',
            provider: 'github',
            identity_data: {
              sub: githubId,
              email: VALID_EMAIL,
              email_verified: true,
            },
            created_at: confirmedDate,
          },
        ],
      };

      const result = extractVerifiedIdentities(user);
      expect(result.identities).toHaveLength(1);
      expect(result.identities[0]!.provider).toBe('github');
      expect(result.identities[0]!.providerSubject).toBe(githubId);
      expect(result.identities[0]!.providerSubject).not.toBe('ident-github-internal-record-id');
    });

    it('fails closed when OAuth identity lacks identity_data provider_id/sub (never falls back to ident.id, identity_id, or user.id)', () => {
      const confirmedDate = new Date().toISOString();
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'google' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: confirmedDate,
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [
          {
            id: 'ident-google-record-id',
            user_id: VALID_USER_ID,
            identity_id: '22222222-2222-4222-8222-222222222222',
            provider: 'google',
            identity_data: {
              email: VALID_EMAIL,
              email_verified: true,
            },
            created_at: confirmedDate,
          },
        ],
      };

      expect(() => extractVerifiedIdentities(user)).toThrowError(AuthError);
      try {
        extractVerifiedIdentities(user);
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_PROVIDER_ERROR');
        expect(authErr.statusCode).toBe(403);
      }
    });

    it('fails closed when OAuth identity_data provider_id or sub is empty/whitespace', () => {
      const confirmedDate = new Date().toISOString();
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'github' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: confirmedDate,
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [
          {
            id: 'ident-github-1',
            user_id: VALID_USER_ID,
            identity_id: '22222222-2222-4222-8222-222222222222',
            provider: 'github',
            identity_data: {
              provider_id: '   ',
              sub: '84729103',
              email: VALID_EMAIL,
              email_verified: true,
            },
            created_at: confirmedDate,
          },
        ],
      };

      expect(() => extractVerifiedIdentities(user)).toThrowError(AuthError);
      try {
        extractVerifiedIdentities(user);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_PROVIDER_ERROR');
        expect((err as AuthError).statusCode).toBe(403);
      }
    });

    it('fails closed when OAuth identity_data has ambiguous/conflicting provider_id and sub', () => {
      const confirmedDate = new Date().toISOString();
      const user: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'google' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: confirmedDate,
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [
          {
            id: '10928347102938471',
            user_id: VALID_USER_ID,
            identity_id: '22222222-2222-4222-8222-222222222222',
            provider: 'google',
            identity_data: {
              provider_id: '10928347102938471',
              sub: '99999999999999999',
              email: VALID_EMAIL,
              email_verified: true,
            },
            created_at: confirmedDate,
          },
        ],
      };

      expect(() => extractVerifiedIdentities(user)).toThrowError(AuthError);
      try {
        extractVerifiedIdentities(user);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_PROVIDER_ERROR');
        expect((err as AuthError).statusCode).toBe(403);
      }
    });

    it('fails closed when OAuth identity_data provider_id equals internal identity_id, user.id, or a UUID', () => {
      const confirmedDate = new Date().toISOString();
      const internalIdentityId = '22222222-2222-4222-8222-222222222222';

      const withUserId: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'google' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: confirmedDate,
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [
          {
            id: VALID_USER_ID,
            user_id: VALID_USER_ID,
            identity_id: internalIdentityId,
            provider: 'google',
            identity_data: {
              provider_id: VALID_USER_ID,
              email: VALID_EMAIL,
              email_verified: true,
            },
            created_at: confirmedDate,
          },
        ],
      };

      const withIdentityId: User = {
        ...withUserId,
        identities: [
          {
            id: internalIdentityId,
            user_id: VALID_USER_ID,
            identity_id: internalIdentityId,
            provider: 'github',
            identity_data: {
              provider_id: internalIdentityId,
              email: VALID_EMAIL,
              email_verified: true,
            },
            created_at: confirmedDate,
          },
        ],
      };

      expect(() => extractVerifiedIdentities(withUserId)).toThrowError(AuthError);
      expect(() => extractVerifiedIdentities(withIdentityId)).toThrowError(AuthError);
    });

    it('does not synthesize Google or GitHub identities when identities array is empty (retains supabase_email UUID mapping)', () => {
      const confirmedDate = new Date().toISOString();

      const googleEmptyUser: User = {
        id: VALID_USER_ID,
        app_metadata: { provider: 'google' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: confirmedDate,
        email: VALID_EMAIL,
        email_confirmed_at: confirmedDate,
        identities: [],
      };

      const githubEmptyUser: User = {
        ...googleEmptyUser,
        app_metadata: { provider: 'github' },
      };

      const emailEmptyUser: User = {
        ...googleEmptyUser,
        app_metadata: { provider: 'email' },
      };

      expect(() => extractVerifiedIdentities(googleEmptyUser)).toThrowError(AuthError);
      expect(() => extractVerifiedIdentities(githubEmptyUser)).toThrowError(AuthError);

      const emailResult = extractVerifiedIdentities(emailEmptyUser);
      expect(emailResult.identities).toEqual([
        {
          provider: 'supabase_email',
          providerSubject: VALID_USER_ID,
          emailAtProvider: VALID_EMAIL,
          emailVerified: true,
        },
      ]);
    });
  });

  describe('SupabaseTokenVerifier (Integration Adapter)', () => {
    it('uses local cryptographic verification when jwtSecret is configured', async () => {
      const verifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key-test',
        jwtSecret: TEST_SECRET,
      });

      const token = createSignedHs256Token();
      const claims = await verifier.verifyToken(token);

      expect(claims.sub).toBe(VALID_USER_ID);
      expect(claims.email).toBe(VALID_EMAIL);
    });

    it('rejects banned user during authoritative verification', async () => {
      const bannedExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
      const mockClient = {
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: VALID_USER_ID,
                email: VALID_EMAIL,
                email_confirmed_at: new Date().toISOString(),
                banned_until: bannedExpiry,
                app_metadata: { provider: 'email' },
                user_metadata: {},
                aud: 'authenticated',
                created_at: new Date().toISOString(),
              },
            },
            error: null,
          }),
        },
      };

      const verifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key-test',
        client: mockClient as unknown as import('@supabase/supabase-js').SupabaseClient,
      });

      await expect(verifier.verifyAuthoritativeUser('dummy-token')).rejects.toThrowError(AuthError);
      try {
        await verifier.verifyAuthoritativeUser('dummy-token');
      } catch (err) {
        const authErr = err as AuthError;
        expect(authErr.code).toBe('AUTH_USER_BANNED');
        expect(authErr.statusCode).toBe(403);
      }
    });

    it('distinguishes GoTrue 5xx/network outages (503 AUTH_PROVIDER_UNAVAILABLE) from revoked tokens (401 AUTH_INVALID_TOKEN)', async () => {
      const outageClient = {
        auth: {
          getUser: async () => {
            throw new TypeError('fetch failed: ECONNREFUSED');
          },
        },
      };
      const outageVerifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key-test',
        client: outageClient as unknown as import('@supabase/supabase-js').SupabaseClient,
      });

      await expect(outageVerifier.verifyAuthoritativeUser('dummy-token')).rejects.toMatchObject({
        code: 'AUTH_PROVIDER_UNAVAILABLE',
        statusCode: 503,
      });

      const timeoutClient = {
        auth: {
          getUser: () => new Promise(() => {}), // never resolves
        },
      };
      const timeoutVerifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key-test',
        requestTimeoutMs: 25,
        client: timeoutClient as unknown as import('@supabase/supabase-js').SupabaseClient,
      });

      await expect(timeoutVerifier.verifyAuthoritativeUser('dummy-token')).rejects.toMatchObject({
        code: 'AUTH_PROVIDER_UNAVAILABLE',
        statusCode: 503,
      });

      const { AuthApiError } = await import('@supabase/supabase-js');
      const revokedClient = {
        auth: {
          getUser: async () => ({
            data: { user: null },
            error: new AuthApiError('Session from session_id claim in JWT does not exist', 401, 'session_not_found'),
          }),
        },
      };
      const revokedVerifier = new SupabaseTokenVerifier({
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key-test',
        client: revokedClient as unknown as import('@supabase/supabase-js').SupabaseClient,
      });

      await expect(revokedVerifier.verifyAuthoritativeUser('dummy-token')).rejects.toMatchObject({
        code: 'AUTH_INVALID_TOKEN',
        statusCode: 401,
      });
    });

    it('enforces key-matched algorithms (blocking HS256/RS256/ES256 confusion), supports JWK ES256 keys, and throws 500 AUTH_CONFIGURATION_ERROR when unconfigured', () => {
      const unconfigured = new LocalJwtVerifier({});
      const hsToken = createSignedHs256Token();
      expect(() => unconfigured.verify(hsToken)).toThrowError(AuthError);
      try {
        unconfigured.verify(hsToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_CONFIGURATION_ERROR');
        expect((err as AuthError).statusCode).toBe(500);
      }

      // Generate EC P-256 key pair and verify using JWK string (as returned by Supabase JWKS)
      const { publicKey: ecPub, privateKey: ecPriv } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
      });
      const jwkString = JSON.stringify(ecPub.export({ format: 'jwk' }));
      const jwkEsVerifier = new LocalJwtVerifier({
        publicKey: jwkString,
        expectedAudience: 'authenticated',
      });

      const nowSec = Math.floor(Date.now() / 1000);
      const rawHeader = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
      const rawPayload = Buffer.from(
        JSON.stringify({
          sub: VALID_USER_ID,
          email: VALID_EMAIL,
          aud: 'authenticated',
          role: 'authenticated',
          iat: nowSec,
          exp: nowSec + 3600,
        }),
      ).toString('base64url');
      const signer = crypto.createSign('SHA256');
      signer.update(`${rawHeader}.${rawPayload}`);
      const sig = signer.sign({ key: ecPriv, dsaEncoding: 'ieee-p1363' }, 'base64url');
      const esToken = `${rawHeader}.${rawPayload}.${sig}`;

      const claims = jwkEsVerifier.verify(esToken);
      expect(claims.sub).toBe(VALID_USER_ID);

      // ES256-configured verifier must block HS256 algorithm confusion with 401 AUTH_INVALID_ALGORITHM
      expect(() => jwkEsVerifier.verify(hsToken)).toThrowError(AuthError);
      try {
        jwkEsVerifier.verify(hsToken);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_INVALID_ALGORITHM');
        expect((err as AuthError).statusCode).toBe(401);
      }
    });
  });

  describe('MockTokenVerifier (Offline Test Harness)', () => {
    const mockVerifier = new MockTokenVerifier();

    it('mints and verifies synthetic cryptographic tokens offline', async () => {
      const token = mockVerifier.mintToken({
        sub: VALID_USER_ID,
        email: VALID_EMAIL,
        user_metadata: { full_name: 'Mock Student' },
      });

      const claims = await mockVerifier.verifyToken(token);
      expect(claims.sub).toBe(VALID_USER_ID);
      expect(claims.email).toBe(VALID_EMAIL);
      expect(claims.userMetadata?.full_name).toBe('Mock Student');
    });

    it('allows registering and retrieving mock authoritative user records', async () => {
      const payload = {
        sub: VALID_USER_ID,
        email: VALID_EMAIL,
        emailConfirmedAt: new Date(),
        identities: [
          {
            provider: 'google' as const,
            providerSubject: 'google-sub-999',
            emailVerified: true,
          },
        ],
        displayName: 'Google Student',
      };
      mockVerifier.registerAuthoritativeUser(payload);

      const token = mockVerifier.mintToken({ sub: VALID_USER_ID, email: VALID_EMAIL });
      const authoritative = await mockVerifier.verifyAuthoritativeUser(token);

      expect(authoritative.sub).toBe(VALID_USER_ID);
      expect(authoritative.displayName).toBe('Google Student');
      expect(authoritative.identities[0]!.providerSubject).toBe('google-sub-999');
    });

    it('refuses to synthesize OAuth identity using claims.sub when user is not explicitly registered', async () => {
      const freshMock = new MockTokenVerifier();
      const token = freshMock.mintToken({
        sub: VALID_USER_ID,
        email: VALID_EMAIL,
        app_metadata: { provider: 'google' },
      });

      await expect(freshMock.verifyAuthoritativeUser(token)).rejects.toThrowError(AuthError);
      try {
        await freshMock.verifyAuthoritativeUser(token);
      } catch (err) {
        expect((err as AuthError).code).toBe('AUTH_PROVIDER_ERROR');
        expect((err as AuthError).statusCode).toBe(403);
      }
    });
  });

  describe('mapSupabaseProvider', () => {
    it('maps known provider strings correctly', () => {
      expect(mapSupabaseProvider('google')).toBe('google');
      expect(mapSupabaseProvider('Google')).toBe('google');
      expect(mapSupabaseProvider('github')).toBe('github');
      expect(mapSupabaseProvider('email')).toBe('supabase_email');
      expect(mapSupabaseProvider('unknown_provider')).toBe('supabase_email');
    });
  });
});
