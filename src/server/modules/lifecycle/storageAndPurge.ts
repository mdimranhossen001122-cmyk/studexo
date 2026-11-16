export const ACCOUNT_DELETION_GRACE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type PurgeState = 'none' | 'pending_purge' | 'purging' | 'purge_failed' | 'purged';
export type FileUploadStatus = 'pending' | 'uploaded' | 'verified' | 'quarantined' | 'deleted';
export type AccountStatus = 'active' | 'suspended' | 'pending_deletion';

export interface AuthenticatedJwtSubject {
  supabaseAuthUserId: string;
  provider?: 'supabase_email' | 'google' | 'github';
  providerSubject?: string;
}

export interface UserLifecycleRecord {
  id: string;
  supabaseAuthUserId: string | null;
  status: AccountStatus;
  purgeState: PurgeState;
  deletionRequestedAt: Date | null;
  deletionScheduledFor: Date | null;
  purgeLeaseOwner?: string | null;
  purgeLeaseUntil?: Date | null;
  purgeAttempts: number;
  lastPurgeError?: string | null;
}

export interface StoredFileLifecycleRecord {
  id: string;
  ownerUserId: string;
  storageBucket: string;
  objectKey: string;
  uploadStatus: FileUploadStatus;
  purgeState: PurgeState;
  deletedAt: Date | null;
  deletedByUserId?: string | null;
  purgedAt: Date | null;
  purgeAttempts: number;
  purgeLeaseUntil?: Date | null;
  lastPurgeError?: string | null;
}

export interface StorageObjectAdapter {
  removeObject(bucket: string, objectKey: string): Promise<void>;
  verifyObjectAbsent(bucket: string, objectKey: string): Promise<boolean>;
}

/**
 * Stage 1 (API role `studexo_app`) repository contract for initiating draft stored-file deletions.
 *
 * Strictly isolated from `FilePurgeWorkerRepository` and `StorageObjectAdapter`:
 * - `requestFileDeletion()` invokes `studexo.request_stored_file_deletion(fileId, actorUserId)` as
 *   `studexo_app`, locking the row `FOR UPDATE`, validating active actor & ownership/admin rights
 *   plus zero `document_versions` references, attributing `deleted_by_user_id`, and transitioning
 *   `purge_state` `none -> pending_purge`.
 * - Never performs reference rollbacks, purge leases, `purged` transitions, or Storage removals.
 */
export interface FileDeletionRequestRepository {
  getOwnedFile(fileId: string, ownerUserId: string): Promise<StoredFileLifecycleRecord | null>;
  requestFileDeletion(fileId: string, actorUserId: string): Promise<StoredFileLifecycleRecord | null>;
}

/**
 * Stage 2 (Background worker role `studexo_purge_worker`) repository contract for Storage-first
 * file purging, pre-lease reference re-verification/rollback, and purge leasing.
 *
 * Concrete PostgreSQL implementations MUST uphold the locking protocol paired with
 * `studexo.guard_document_versions_integrity()` and `studexo.revert_stored_file_deletion_request(uuid, uuid)`:
 * - `guard_document_versions_integrity()` locks the target `studexo.stored_files` row `FOR SHARE`.
 * - `markFilePendingPurge()` and `acquireFilePurgeLease()` lock the target `studexo.stored_files` row
 *   `FOR UPDATE` inside a database transaction before calling `countBlockingReferences()` so
 *   concurrent `document_versions` insertions serialize cleanly.
 * - `revertPendingPurgeToNone()` invokes `studexo.revert_stored_file_deletion_request(fileId, ownerUserId)`
 *   only when untouched `pending_purge` files (`purge_attempts = 0`, `purge_lease_until IS NULL`)
 *   fail pre-lease reference checks, atomically resetting `purge_state = 'none'`,
 *   `deleted_by_user_id = NULL`, and `purge_requested_at = NULL`.
 * - `markFilePurged()` runs strictly as `studexo_purge_worker` and NEVER mutates `deleted_by_user_id`.
 */
export interface FilePurgeWorkerRepository {
  getFileForPurge(fileId: string, ownerUserId: string): Promise<StoredFileLifecycleRecord | null>;
  markFilePendingPurge(
    fileId: string,
    ownerUserId: string,
    requestedAt: Date,
  ): Promise<StoredFileLifecycleRecord | null>;
  countBlockingReferences(fileId: string, ownerUserId: string): Promise<number>;
  acquireFilePurgeLease(
    fileId: string,
    ownerUserId: string,
    leaseUntil: Date,
  ): Promise<StoredFileLifecycleRecord | null>;
  markFilePurged(fileId: string, ownerUserId: string, completedAt: Date): Promise<void>;
  markFilePurgeFailed(fileId: string, ownerUserId: string, errorMessage: string): Promise<void>;
  revertPendingPurgeToNone(fileId: string, ownerUserId: string): Promise<void>;
}

export interface FilePurgeLeaseRecoveryRepository {
  markExpiredPurgeLeaseFailed(params: {
    fileId: string;
    ownerUserId: string;
    failedAt: Date;
    errorMessage: string;
  }): Promise<StoredFileLifecycleRecord | null>;
}

export interface AccountPurgeRepository {
  getUserForPurge(userId: string): Promise<UserLifecycleRecord | null>;
  markUserPurging(params: {
    userId: string;
    leaseOwner: string;
    leaseUntil: Date;
  }): Promise<UserLifecycleRecord | null>;
  markUserPurgeFailed(userId: string, errorMessage: string): Promise<void>;
  listUserStoredFiles(userId: string): Promise<StoredFileLifecycleRecord[]>;
  executeAccountPurgeRpc(userId: string): Promise<void>;
}

export interface AccountPurgeLeaseRecoveryRepository {
  markExpiredAccountPurgeLeaseFailed(params: {
    userId: string;
    failedAt: Date;
    errorMessage: string;
  }): Promise<UserLifecycleRecord | null>;
  findExternalIdentityOutboxByAuthUserId(
    supabaseAuthUserId: string,
  ): Promise<ExternalIdentityOutboxItem | null>;
}

export interface ExternalIdentityOutboxItem {
  id: string;
  formerUserId: string;
  supabaseAuthUserId: string;
  status: Extract<PurgeState, 'pending_purge' | 'purging' | 'purge_failed' | 'purged'>;
  attemptCount: number;
  maxAttempts: number;
}

export interface SupabaseAuthAdminAdapter {
  deleteUserById(supabaseAuthUserId: string): Promise<{ status: 'deleted' | 'already_absent' }>;
}

export interface UserIdentityRepository {
  findUserBySupabaseAuthId(supabaseAuthUserId: string): Promise<UserLifecycleRecord | null>;
  findUserByProviderIdentity(
    provider: 'supabase_email' | 'google' | 'github',
    providerSubject: string,
  ): Promise<UserLifecycleRecord | null>;
}

/**
 * Resolves the Studexo internal user strictly from verified server JWT claims
 * (`sub` or `auth_identities(provider, providerSubject)`), never from client-supplied userId.
 */
export async function resolveAuthenticatedUser(
  subject: AuthenticatedJwtSubject,
  repo: UserIdentityRepository,
): Promise<UserLifecycleRecord | null> {
  const byAuthSub = await repo.findUserBySupabaseAuthId(subject.supabaseAuthUserId);
  if (byAuthSub) {
    return byAuthSub;
  }

  if (subject.provider && subject.providerSubject) {
    return repo.findUserByProviderIdentity(subject.provider, subject.providerSubject);
  }

  return null;
}

export function calculateDeletionSchedule(
  requestedAt: Date,
  graceDays = ACCOUNT_DELETION_GRACE_DAYS,
): { deletionRequestedAt: Date; deletionScheduledFor: Date } {
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new Error('graceDays must be a non-negative integer.');
  }
  const deletionRequestedAt = new Date(requestedAt.getTime());
  const deletionScheduledFor = new Date(requestedAt.getTime() + graceDays * MS_PER_DAY);
  return { deletionRequestedAt, deletionScheduledFor };
}

export function canCancelScheduledDeletion(user: UserLifecycleRecord, now: Date): boolean {
  return (
    user.status === 'pending_deletion' &&
    user.purgeState === 'pending_purge' &&
    user.deletionScheduledFor !== null &&
    now.getTime() < user.deletionScheduledFor.getTime()
  );
}

/**
 * Upload-completion race guard: refuses transitioning a pending upload to `uploaded`
 * if a purge has already been requested or started for that `stored_files` row.
 */
export function assertUploadCanComplete(file: StoredFileLifecycleRecord): void {
  if (file.purgeState !== 'none') {
    throw new Error(
      `Cannot complete upload for stored file ${file.id}: purge_state is '${file.purgeState}'.`,
    );
  }
  if (file.uploadStatus !== 'pending' && file.uploadStatus !== 'uploaded') {
    throw new Error(
      `Cannot complete upload for stored file ${file.id}: upload_status is '${file.uploadStatus}'.`,
    );
  }
}

export function isPurgeLeaseExpired(
  file: Pick<StoredFileLifecycleRecord, 'purgeState' | 'purgeLeaseUntil'>,
  now: Date,
): boolean {
  if (file.purgeState !== 'purging') {
    return false;
  }
  if (!file.purgeLeaseUntil) {
    return true;
  }
  return file.purgeLeaseUntil.getTime() <= now.getTime();
}

export interface RecoverExpiredLeaseResult {
  fileId: string;
  outcome: 'recovered_to_purge_failed' | 'skipped_terminal' | 'skipped_not_purging' | 'active_lease';
  file: StoredFileLifecycleRecord;
}

/**
 * Recovers an expired `purging` lease back to `purge_failed` without stealing active leases
 * or modifying terminal `purged` / `deleted` files. Concrete repositories must preserve
 * `purge_attempts` and append/retain error diagnostics.
 */
export async function recoverExpiredStoredFilePurgeLease(params: {
  file: StoredFileLifecycleRecord;
  now?: Date;
  repo: FilePurgeLeaseRecoveryRepository;
}): Promise<RecoverExpiredLeaseResult> {
  const now = params.now ?? new Date();
  const { file } = params;

  if (file.purgeState === 'purged' || file.uploadStatus === 'deleted') {
    return { fileId: file.id, outcome: 'skipped_terminal', file };
  }

  if (file.purgeState !== 'purging') {
    return { fileId: file.id, outcome: 'skipped_not_purging', file };
  }

  if (!isPurgeLeaseExpired(file, now)) {
    return { fileId: file.id, outcome: 'active_lease', file };
  }

  const leaseExpiryIso = file.purgeLeaseUntil ? file.purgeLeaseUntil.toISOString() : 'unset';
  const previousError = file.lastPurgeError ? ` | previous: ${file.lastPurgeError}` : '';
  const errorMessage = `Purge lease expired at ${leaseExpiryIso}; recovered at ${now.toISOString()}${previousError}`;

  const recovered = await params.repo.markExpiredPurgeLeaseFailed({
    fileId: file.id,
    ownerUserId: file.ownerUserId,
    failedAt: now,
    errorMessage,
  });

  if (!recovered) {
    throw new Error(`Failed to recover expired purge lease for stored_file ${file.id}.`);
  }

  return {
    fileId: file.id,
    outcome: 'recovered_to_purge_failed',
    file: recovered,
  };
}

export function isAccountPurgeLeaseExpired(
  user: Pick<UserLifecycleRecord, 'purgeState' | 'purgeLeaseUntil'>,
  now: Date,
): boolean {
  if (user.purgeState !== 'purging') {
    return false;
  }
  if (!user.purgeLeaseUntil) {
    return true;
  }
  return user.purgeLeaseUntil.getTime() <= now.getTime();
}

export interface RecoverInterruptedAccountPurgeResult {
  userId: string;
  outcome:
    | 'recovered_to_purge_failed'
    | 'active_lease'
    | 'blocked_active_file_lease'
    | 'skipped_not_purging'
    | 'skipped_not_pending_deletion'
    | 'skipped_terminal'
    | 'user_already_purged';
  user: UserLifecycleRecord | null;
  recoveredFileIds: string[];
  storageConfirmedAbsentFileIds: string[];
  storageStillPresentFileIds: string[];
  outboxStatus: ExternalIdentityOutboxItem['status'] | null;
}

/**
 * Recovers an interrupted `users.purge_state = 'purging'` account whose lease expired without
 * stealing active user/file leases or ever reverting `pending_deletion` back to `active` / `none`.
 * Re-checks user deletion state, all stored_files rows, actual Storage object absence (since DB
 * rollback never restores already-deleted Storage objects), and the external identity outbox.
 */
export async function recoverInterruptedAccountPurge(params: {
  userId: string;
  now?: Date;
  accountRepo: Pick<AccountPurgeRepository, 'getUserForPurge' | 'listUserStoredFiles'>;
  fileRecoveryRepo: FilePurgeLeaseRecoveryRepository;
  recoveryRepo: AccountPurgeLeaseRecoveryRepository;
  storage: Pick<StorageObjectAdapter, 'verifyObjectAbsent'>;
}): Promise<RecoverInterruptedAccountPurgeResult> {
  const now = params.now ?? new Date();
  const user = await params.accountRepo.getUserForPurge(params.userId);

  if (!user) {
    return {
      userId: params.userId,
      outcome: 'user_already_purged',
      user: null,
      recoveredFileIds: [],
      storageConfirmedAbsentFileIds: [],
      storageStillPresentFileIds: [],
      outboxStatus: null,
    };
  }

  if (user.purgeState === 'purged') {
    return {
      userId: user.id,
      outcome: 'skipped_terminal',
      user,
      recoveredFileIds: [],
      storageConfirmedAbsentFileIds: [],
      storageStillPresentFileIds: [],
      outboxStatus: null,
    };
  }

  if (user.status !== 'pending_deletion') {
    return {
      userId: user.id,
      outcome: 'skipped_not_pending_deletion',
      user,
      recoveredFileIds: [],
      storageConfirmedAbsentFileIds: [],
      storageStillPresentFileIds: [],
      outboxStatus: null,
    };
  }

  if (user.purgeState !== 'purging') {
    return {
      userId: user.id,
      outcome: 'skipped_not_purging',
      user,
      recoveredFileIds: [],
      storageConfirmedAbsentFileIds: [],
      storageStillPresentFileIds: [],
      outboxStatus: null,
    };
  }

  if (!isAccountPurgeLeaseExpired(user, now)) {
    return {
      userId: user.id,
      outcome: 'active_lease',
      user,
      recoveredFileIds: [],
      storageConfirmedAbsentFileIds: [],
      storageStillPresentFileIds: [],
      outboxStatus: null,
    };
  }

  const files = await params.accountRepo.listUserStoredFiles(user.id);
  for (const file of files) {
    if (file.purgeState === 'purging' && !isPurgeLeaseExpired(file, now)) {
      return {
        userId: user.id,
        outcome: 'blocked_active_file_lease',
        user,
        recoveredFileIds: [],
        storageConfirmedAbsentFileIds: [],
        storageStillPresentFileIds: [],
        outboxStatus: null,
      };
    }
  }

  const recoveredFileIds: string[] = [];
  const storageConfirmedAbsentFileIds: string[] = [];
  const storageStillPresentFileIds: string[] = [];

  for (const file of files) {
    if (file.purgeState === 'purging') {
      const recoveredFile = await recoverExpiredStoredFilePurgeLease({
        file,
        now,
        repo: params.fileRecoveryRepo,
      });
      if (recoveredFile.outcome === 'recovered_to_purge_failed') {
        recoveredFileIds.push(file.id);
      }
    }

    if (!(file.purgeState === 'purged' && file.uploadStatus === 'deleted')) {
      const isAbsent = await params.storage.verifyObjectAbsent(file.storageBucket, file.objectKey);
      if (isAbsent) {
        storageConfirmedAbsentFileIds.push(file.id);
      } else {
        storageStillPresentFileIds.push(file.id);
      }
    }
  }

  const outboxItem = user.supabaseAuthUserId
    ? await params.recoveryRepo.findExternalIdentityOutboxByAuthUserId(user.supabaseAuthUserId)
    : null;
  const outboxStatus = outboxItem?.status ?? null;

  const leaseExpiryIso = user.purgeLeaseUntil ? user.purgeLeaseUntil.toISOString() : 'unset';
  const priorOwner = user.purgeLeaseOwner ?? 'unknown';
  const previousError = user.lastPurgeError ? ` | previous: ${user.lastPurgeError}` : '';
  const errorMessage =
    `Account purge lease (owner=${priorOwner}) expired at ${leaseExpiryIso}; ` +
    `recovered at ${now.toISOString()} (recoveredFiles=${recoveredFileIds.length}, ` +
    `storageAbsent=${storageConfirmedAbsentFileIds.length}, storagePresent=${storageStillPresentFileIds.length}, ` +
    `outbox=${outboxStatus ?? 'none'})${previousError}`;

  const recoveredUser = await params.recoveryRepo.markExpiredAccountPurgeLeaseFailed({
    userId: user.id,
    failedAt: now,
    errorMessage,
  });

  if (!recoveredUser) {
    throw new Error(`Failed to recover expired account purge lease for user ${user.id}.`);
  }
  if (recoveredUser.status !== 'pending_deletion' || recoveredUser.purgeState !== 'purge_failed') {
    throw new Error(
      `Invalid account purge recovery state for user ${user.id}: status='${recoveredUser.status}', purgeState='${recoveredUser.purgeState}'.`,
    );
  }

  return {
    userId: user.id,
    outcome: 'recovered_to_purge_failed',
    user: recoveredUser,
    recoveredFileIds,
    storageConfirmedAbsentFileIds,
    storageStillPresentFileIds,
    outboxStatus,
  };
}

export interface RequestDraftFileDeletionResult {
  fileId: string;
  outcome: 'pending_purge' | 'already_purged';
  httpStatus: 202 | 200;
}

/**
 * Stage 1 API deletion handler (`studexo_app` role only):
 * Verifies ownership, records attribution (`deleted_by_user_id`) and `none -> pending_purge`
 * via `studexo.request_stored_file_deletion(fileId, actorUserId)`, and returns an async 202
 * queued outcome without invoking worker-only DB RPCs or Storage removal APIs.
 */
export async function requestDraftStoredFileDeletion(params: {
  fileId: string;
  authenticatedUserId: string;
  repo: FileDeletionRequestRepository;
}): Promise<RequestDraftFileDeletionResult> {
  const initial = await params.repo.getOwnedFile(params.fileId, params.authenticatedUserId);
  if (!initial) {
    throw new Error(`Owned stored_file not found: ${params.fileId}`);
  }
  if (initial.purgeState === 'purged' && initial.uploadStatus === 'deleted') {
    return { fileId: initial.id, outcome: 'already_purged', httpStatus: 200 };
  }
  if (
    initial.purgeState === 'pending_purge' ||
    initial.purgeState === 'purging' ||
    initial.purgeState === 'purge_failed'
  ) {
    return { fileId: initial.id, outcome: 'pending_purge', httpStatus: 202 };
  }

  const markedPending = await params.repo.requestFileDeletion(
    initial.id,
    params.authenticatedUserId,
  );
  if (!markedPending) {
    throw new Error(
      `Unable to mark stored_file ${initial.id} pending_purge (concurrent state change).`,
    );
  }

  return {
    fileId: markedPending.id,
    outcome: 'pending_purge',
    httpStatus: 202,
  };
}

export interface ProcessPendingFileDeletionResult {
  fileId: string;
  outcome:
    | 'purged'
    | 'already_purged'
    | 'reverted_blocked_by_refs'
    | 'skipped_not_pending';
  blockingReferences?: number;
}

/**
 * Stage 2 Background Worker handler (`studexo_purge_worker` role + Storage admin adapter):
 * Inspects queued/retryable stored_files, reverts untouched `pending_purge` rows when blocking
 * `document_versions` references exist, acquires a short-lived `purging` lease, deletes and
 * verifies object absence from Storage, and transitions the row to `purged`/`deleted` (preserving
 * `deleted_by_user_id`) or `purge_failed`.
 */
export async function processPendingStoredFileDeletion(params: {
  fileId: string;
  ownerUserId: string;
  now?: Date;
  leaseSeconds?: number;
  repo: FilePurgeWorkerRepository;
  storage: StorageObjectAdapter;
}): Promise<ProcessPendingFileDeletionResult> {
  const now = params.now ?? new Date();
  const leaseSeconds = params.leaseSeconds ?? 60;

  const file = await params.repo.getFileForPurge(params.fileId, params.ownerUserId);
  if (!file) {
    throw new Error(`Stored file not found for purge: ${params.fileId}`);
  }
  if (file.purgeState === 'purged' && file.uploadStatus === 'deleted') {
    return { fileId: file.id, outcome: 'already_purged' };
  }
  if (file.purgeState === 'none') {
    return { fileId: file.id, outcome: 'skipped_not_pending' };
  }
  if (file.purgeState === 'purging' && !isPurgeLeaseExpired(file, now)) {
    throw new Error(`Active purge lease held for stored_file ${file.id}.`);
  }

  if (file.purgeState === 'pending_purge') {
    const blockingRefs = await params.repo.countBlockingReferences(
      file.id,
      params.ownerUserId,
    );
    if (blockingRefs > 0) {
      if (file.purgeAttempts === 0 && !file.purgeLeaseUntil && !file.lastPurgeError) {
        await params.repo.revertPendingPurgeToNone(file.id, params.ownerUserId);
        return {
          fileId: file.id,
          outcome: 'reverted_blocked_by_refs',
          blockingReferences: blockingRefs,
        };
      }
      throw new Error(
        `Cannot purge stored_file ${file.id}: ${blockingRefs} active document or evidence reference(s) remain.`,
      );
    }
  }

  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
  const leased = await params.repo.acquireFilePurgeLease(
    file.id,
    params.ownerUserId,
    leaseUntil,
  );
  if (!leased) {
    throw new Error(`Purge lease busy for stored_file ${file.id}.`);
  }

  try {
    await params.storage.removeObject(leased.storageBucket, leased.objectKey);

    const isAbsent = await params.storage.verifyObjectAbsent(
      leased.storageBucket,
      leased.objectKey,
    );
    if (!isAbsent) {
      throw new Error(
        `Storage object ${leased.storageBucket}/${leased.objectKey} still exists after removal attempt.`,
      );
    }

    await params.repo.markFilePurged(leased.id, params.ownerUserId, now);
    return { fileId: leased.id, outcome: 'purged' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Storage purge error';
    await params.repo.markFilePurgeFailed(leased.id, params.ownerUserId, message);
    throw error;
  }
}

export interface AccountPurgeExecutionResult {
  userId: string;
  purgedFileIds: string[];
  alreadyPurgedFileIds: string[];
  databasePurgeExecuted: true;
}

/**
 * Storage-first account purge orchestrator (`studexo_purge_worker` role):
 * 1. Validates pending_deletion grace expiry.
 * 2. Purges and confirms deletion of EVERY Storage object for the user BEFORE touching DB rows,
 *    checking `markFilePendingPurge` and `acquireFilePurgeLease` return values before any Storage call.
 * 3. Invokes `studexo.execute_account_purge(userId)` only after 100% of stored_files are `purged`.
 */
export async function executeStorageFirstAccountPurge(params: {
  userId: string;
  leaseOwner?: string;
  now?: Date;
  leaseSeconds?: number;
  accountRepo: AccountPurgeRepository;
  fileRepo: FilePurgeWorkerRepository;
  storage: StorageObjectAdapter;
}): Promise<AccountPurgeExecutionResult> {
  const now = params.now ?? new Date();
  const leaseSeconds = params.leaseSeconds ?? 60;
  const leaseOwner = params.leaseOwner ?? 'purge-worker';
  const user = await params.accountRepo.getUserForPurge(params.userId);
  if (!user) {
    throw new Error(`User not found for account purge: ${params.userId}`);
  }
  if (user.status !== 'pending_deletion') {
    throw new Error(`User ${user.id} is not in pending_deletion status.`);
  }
  if (!user.deletionScheduledFor || now.getTime() < user.deletionScheduledFor.getTime()) {
    throw new Error(`Account deletion grace period has not expired for user ${user.id}.`);
  }
  if (user.purgeState !== 'pending_purge' && user.purgeState !== 'purge_failed') {
    throw new Error(`User ${user.id} cannot start purge from purge_state '${user.purgeState}'.`);
  }

  const accountLeaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
  const claimedUser = await params.accountRepo.markUserPurging({
    userId: user.id,
    leaseOwner,
    leaseUntil: accountLeaseUntil,
  });
  if (!claimedUser) {
    throw new Error(`Unable to claim account purge lease for user ${user.id}.`);
  }

  try {
    const files = await params.accountRepo.listUserStoredFiles(user.id);
    const purgedFileIds: string[] = [];
    const alreadyPurgedFileIds: string[] = [];

    for (const file of files) {
      if (file.purgeState === 'purged' && file.uploadStatus === 'deleted') {
        alreadyPurgedFileIds.push(file.id);
        continue;
      }

      const markedPending = await params.fileRepo.markFilePendingPurge(file.id, user.id, now);
      if (!markedPending) {
        throw new Error(
          `Unable to mark stored_file ${file.id} pending_purge during account purge.`,
        );
      }

      const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
      const leased = await params.fileRepo.acquireFilePurgeLease(file.id, user.id, leaseUntil);
      if (!leased) {
        throw new Error(`Purge lease busy or unavailable for stored_file ${file.id}.`);
      }

      try {
        await params.storage.removeObject(leased.storageBucket, leased.objectKey);
        const isAbsent = await params.storage.verifyObjectAbsent(
          leased.storageBucket,
          leased.objectKey,
        );
        if (!isAbsent) {
          throw new Error(
            `Storage object ${leased.storageBucket}/${leased.objectKey} remained present during account purge.`,
          );
        }
        await params.fileRepo.markFilePurged(leased.id, user.id, now);
        purgedFileIds.push(leased.id);
      } catch (fileError) {
        const fileMessage =
          fileError instanceof Error ? fileError.message : 'Unknown Storage purge error';
        await params.fileRepo.markFilePurgeFailed(leased.id, user.id, fileMessage);
        throw fileError;
      }
    }

    // Re-read all user stored_files to verify 100% are confirmed `purged` before calling DB purge RPC.
    const verifiedFiles = await params.accountRepo.listUserStoredFiles(user.id);
    const unpurged = verifiedFiles.filter((f) => f.purgeState !== 'purged');
    if (unpurged.length > 0) {
      throw new Error(
        `Refusing database purge for user ${user.id}: ${unpurged.length} stored_files remain unpurged.`,
      );
    }

    await params.accountRepo.executeAccountPurgeRpc(user.id);

    return {
      userId: user.id,
      purgedFileIds,
      alreadyPurgedFileIds,
      databasePurgeExecuted: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Account purge failed';
    await params.accountRepo.markUserPurgeFailed(user.id, message);
    throw error;
  }
}

/**
 * Processes one `external_identity_purge_outbox` record after local DB purge completes.
 * Treats missing/already-deleted auth users (404) as idempotent completion.
 */
export async function processExternalIdentityPurgeOutboxItem(
  item: ExternalIdentityOutboxItem,
  authAdmin: SupabaseAuthAdminAdapter,
): Promise<{ status: 'purged' | 'purge_failed'; errorMessage?: string }> {
  if (item.status === 'purged') {
    return { status: 'purged' };
  }
  try {
    await authAdmin.deleteUserById(item.supabaseAuthUserId);
    return { status: 'purged' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'External auth deletion failed';
    return { status: 'purge_failed', errorMessage: message };
  }
}
