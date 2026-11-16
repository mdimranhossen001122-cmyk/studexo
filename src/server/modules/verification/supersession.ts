import crypto from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { StudexoDatabase } from '../../db/client';
import { verificationClaims } from '../../db/schema/verification';

export type VerificationTargetType = 'institution' | 'programme' | 'scholarship';

export interface VerificationClaimTargetKey {
  targetType: VerificationTargetType;
  targetId: string;
  fieldPath: string;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  randomFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface SupersedeClaimInput {
  claimIdToSupersede: string;
  supersedingClaimId: string;
  supersededAt?: Date;
  onCommitted?: (result: SupersedeClaimResult) => Promise<void> | void;
}

export interface SupersedeClaimResult {
  supersededClaimId: string;
  supersedingClaimId: string;
  supersededAt: Date;
  lockKey: string;
  lockId: bigint;
  attempts: number;
}

const RETRYABLE_PG_SQLSTATES = new Set(['40P01', '40001']);
const DISALLOWED_SUPERSEDING_STATUSES = new Set(['superseded', 'rejected', 'disputed']);

/**
 * Canonical lock input string matching PL/pgSQL trigger `guard_verification_claims_supersession()`.
 */
export function buildVerificationClaimLockInput(key: VerificationClaimTargetKey): string {
  return `studexo:vclaim:${key.targetType}:${key.targetId}:${key.fieldPath}`;
}

/**
 * Computes a signed 64-bit BigInt advisory lock key bit-for-bit identical to PostgreSQL:
 *   ('x' || substr(md5(lockInput), 1, 16))::bit(64)::bigint
 */
export function deriveVerificationClaimLockId(key: VerificationClaimTargetKey): {
  lockInput: string;
  lockId: bigint;
} {
  const lockInput = buildVerificationClaimLockInput(key);
  const md5Hex16 = crypto.createHash('md5').update(lockInput, 'utf8').digest('hex').slice(0, 16);
  const lockId = BigInt.asIntN(64, BigInt(`0x${md5Hex16}`));
  return { lockInput, lockId };
}

export function extractTargetKeyFromClaim(claim: {
  institutionId: string | null;
  programmeId: string | null;
  scholarshipId: string | null;
  fieldPath: string;
}): VerificationClaimTargetKey {
  const candidates: Array<{ type: VerificationTargetType; id: string | null }> = [
    { type: 'institution', id: claim.institutionId },
    { type: 'programme', id: claim.programmeId },
    { type: 'scholarship', id: claim.scholarshipId },
  ];
  const present = candidates.filter((c): c is { type: VerificationTargetType; id: string } =>
    Boolean(c.id),
  );
  const [onlyTarget] = present;
  if (present.length !== 1 || !onlyTarget) {
    throw new Error('Verification claim must have exactly one catalog target.');
  }
  return {
    targetType: onlyTarget.type,
    targetId: onlyTarget.id,
    fieldPath: claim.fieldPath,
  };
}

export function extractPgSqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === 'string') {
    return record.code;
  }
  if (record.cause && typeof record.cause === 'object') {
    const causeCode = (record.cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') {
      return causeCode;
    }
  }
  return undefined;
}

export function isRetryableConcurrencyError(error: unknown): boolean {
  const code = extractPgSqlState(error);
  return code !== undefined && RETRYABLE_PG_SQLSTATES.has(code);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a transaction callback at PostgreSQL READ COMMITTED isolation with
 * bounded jittered retries on 40P01 (deadlock_detected) and 40001 (serialization_failure).
 */
export async function withRetryableReadCommittedTransaction<T>(
  runTransaction: (
    fn: (tx: StudexoDatabase) => Promise<T>,
    config: { isolationLevel: 'read committed' },
  ) => Promise<T>,
  operation: (tx: StudexoDatabase, attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<{ result: T; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 25;
  const maxDelayMs = options.maxDelayMs ?? 250;
  const randomFn = options.randomFn ?? Math.random;
  const sleepFn = options.sleepFn ?? defaultSleep;

  if (maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1.');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runTransaction(
        (tx) => operation(tx, attempt),
        { isolationLevel: 'read committed' },
      );
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableConcurrencyError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const expDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitterFactor = 0.5 + randomFn() * 0.5;
      const waitMs = Math.max(1, Math.round(expDelay * jitterFactor));
      await sleepFn(waitMs);
    }
  }

  throw lastError;
}

/**
 * Atomically marks a verification claim as superseded using a deterministic transaction-level
 * advisory lock inside an explicit READ COMMITTED transaction:
 * 1. Read immutable target scope of `claimIdToSupersede` and derive advisory lock ID.
 * 2. Acquire `pg_advisory_xact_lock` BEFORE checking mutable status.
 * 3. Re-read `claimIdToSupersede` and `supersedingClaimId` after lock acquisition.
 * 4. Validate status, target equality, and eligibility of the replacement claim.
 * 5. Apply a conditional UPDATE (`status = locked.status AND superseded_by_claim_id IS NULL`)
 *    and assert exact 1 affected row.
 * 6. Execute `onCommitted` strictly after the transaction commits.
 */
export async function supersedeVerificationClaim(
  db: StudexoDatabase,
  input: SupersedeClaimInput,
  retryOptions?: RetryOptions,
): Promise<SupersedeClaimResult> {
  if (input.claimIdToSupersede === input.supersedingClaimId) {
    throw new Error('A verification claim cannot supersede itself.');
  }

  const supersededAt = input.supersededAt ?? new Date();

  type SupersedeTxPayload = Omit<SupersedeClaimResult, 'attempts'>;

  const { result, attempts } = await withRetryableReadCommittedTransaction<SupersedeTxPayload>(
    (fn, config) => db.transaction(fn, config),
    async (tx): Promise<SupersedeTxPayload> => {
      // Step 1: Read only immutable target scope before locking.
      const [claimScope] = await tx
        .select({
          id: verificationClaims.id,
          institutionId: verificationClaims.institutionId,
          programmeId: verificationClaims.programmeId,
          scholarshipId: verificationClaims.scholarshipId,
          fieldPath: verificationClaims.fieldPath,
        })
        .from(verificationClaims)
        .where(eq(verificationClaims.id, input.claimIdToSupersede))
        .limit(1);

      if (!claimScope) {
        throw new Error(`Verification claim not found: ${input.claimIdToSupersede}`);
      }

      const targetKey = extractTargetKeyFromClaim(claimScope);
      const { lockInput, lockId } = deriveVerificationClaimLockId(targetKey);

      // Step 2: Acquire deterministic domain-level transaction advisory lock BEFORE reading mutable state.
      await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(${lockId.toString()}::bigint)`);

      // Step 3: Re-read target claim under lock so concurrent winners are observed cleanly at READ COMMITTED.
      const [lockedClaim] = await tx
        .select({
          id: verificationClaims.id,
          institutionId: verificationClaims.institutionId,
          programmeId: verificationClaims.programmeId,
          scholarshipId: verificationClaims.scholarshipId,
          fieldPath: verificationClaims.fieldPath,
          status: verificationClaims.status,
          supersededByClaimId: verificationClaims.supersededByClaimId,
        })
        .from(verificationClaims)
        .where(eq(verificationClaims.id, input.claimIdToSupersede))
        .limit(1);

      if (!lockedClaim) {
        throw new Error(`Verification claim not found after lock: ${input.claimIdToSupersede}`);
      }
      if (lockedClaim.status === 'superseded' || lockedClaim.supersededByClaimId !== null) {
        throw new Error(
          `Verification claim ${input.claimIdToSupersede} is already superseded.`,
        );
      }
      if (lockedClaim.status === 'rejected') {
        throw new Error(
          `Rejected verification claim ${input.claimIdToSupersede} cannot be superseded.`,
        );
      }

      // Step 4: Read and validate replacement claim after acquiring the advisory lock.
      const [supersedingClaim] = await tx
        .select({
          id: verificationClaims.id,
          institutionId: verificationClaims.institutionId,
          programmeId: verificationClaims.programmeId,
          scholarshipId: verificationClaims.scholarshipId,
          fieldPath: verificationClaims.fieldPath,
          status: verificationClaims.status,
          supersededByClaimId: verificationClaims.supersededByClaimId,
        })
        .from(verificationClaims)
        .where(eq(verificationClaims.id, input.supersedingClaimId))
        .limit(1);

      if (!supersedingClaim) {
        throw new Error(`Superseding verification claim not found: ${input.supersedingClaimId}`);
      }
      if (
        supersedingClaim.institutionId !== lockedClaim.institutionId ||
        supersedingClaim.programmeId !== lockedClaim.programmeId ||
        supersedingClaim.scholarshipId !== lockedClaim.scholarshipId ||
        supersedingClaim.fieldPath !== lockedClaim.fieldPath
      ) {
        throw new Error(
          `Superseding verification claim ${input.supersedingClaimId} does not match target entity and field_path.`,
        );
      }
      if (
        supersedingClaim.supersededByClaimId !== null ||
        DISALLOWED_SUPERSEDING_STATUSES.has(supersedingClaim.status)
      ) {
        throw new Error(
          `Superseding verification claim ${input.supersedingClaimId} has ineligible status '${supersedingClaim.status}'.`,
        );
      }

      // Step 5: Conditional UPDATE guarded by observed mutable state + assert exact 1 affected row.
      const updatedRows = await tx
        .update(verificationClaims)
        .set({
          status: 'superseded',
          supersededByClaimId: input.supersedingClaimId,
          supersededAt,
        })
        .where(
          and(
            eq(verificationClaims.id, input.claimIdToSupersede),
            eq(verificationClaims.status, lockedClaim.status),
            isNull(verificationClaims.supersededByClaimId),
          ),
        )
        .returning({ id: verificationClaims.id });

      if (updatedRows.length !== 1) {
        throw new Error(
          `Expected 1 affected row when superseding verification claim ${input.claimIdToSupersede}, got ${updatedRows.length}.`,
        );
      }

      return {
        supersededClaimId: input.claimIdToSupersede,
        supersedingClaimId: input.supersedingClaimId,
        supersededAt,
        lockKey: lockInput,
        lockId,
      };
    },
    retryOptions,
  );

  const finalResult: SupersedeClaimResult = {
    ...result,
    attempts,
  };

  if (input.onCommitted) {
    await input.onCommitted(finalResult);
  }

  return finalResult;
}
