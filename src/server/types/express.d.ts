import type {
  AuthenticatedUser,
  AuthoritativeUserPayload,
  AuthTokenClaims,
} from '../../shared/types/auth';

declare module 'express-serve-static-core' {
  interface Request {
    authClaims?: AuthTokenClaims;
    authoritativeUser?: AuthoritativeUserPayload;
    user?: AuthenticatedUser;
  }
}

export {};
