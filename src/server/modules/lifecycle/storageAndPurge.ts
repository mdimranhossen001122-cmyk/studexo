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

export type FilePurgeLeaseResult =
  | {
      status: 'acquired';
      file: StoredFileLifecycleRecord;
    }
  | {
      status: 'blocked_by_references';
      blockingReferences: number;
      file: StoredFileLifecycleRecord;
    }
  | {
      status: 'unavailable';
      reason: 'not_found' | 'not_eligible' | 'active_lease';
      file: StoredFileLifecycleRecord | null;
    };

/**
 * Stage 2 (Background worker role `studexo_purge_worker`) repository contract for Storage-first
 * file purging, atomic pre-lease reference re-verification/rollback, and purge leasing.
 *
 * Concrete PostgreSQL implementations MUST uphold the locking protocol paired with
 * `studexo.guard_document_versions_integrity()` and `studexo.revert_stored_file_deletion_request(uuid, uuid)`:
 * - `guard_document_versions_integrity()` locks the target `studexo.stored_files` row `FOR SHARE`.
 * - `acquireFilePurgeLeaseIfUnreferenced()` locks `studexo.stored_files` `FOR UPDATE` inside a
 *   `READ COMMITTED` transaction, counts `studexo.document_versions` references inside that same
 *   transaction, computes `purge_lease_until` using PostgreSQL `pg_catalog.now()`, and only
 *   transitions to `purging` when zero blocking references exist.
 * - `acquireFilePurgeLease()` locks `studexo.stored_files` `FOR UPDATE` inside a `READ COMMITTED`
 *   transaction and computes `purge_lease_until` using PostgreSQL `pg_catalog.now()` without
 *   failing on departing-user `document_versions` rows during account purge.
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
    requestedAt?: Date,
  ): Promise<StoredFileLifecycleRecord | null>;
  acquireFilePurgeLeaseIfUnreferenced(
    fileId: string,
    ownerUserId: string,
    leaseSeconds: number,
  ): Promise<FilePurgeLeaseResult>;
  acquireFilePurgeLease(
    fileId: string,
    ownerUserId: string,
    leaseSeconds: number,
  ): Promise<StoredFileLifecycleRecord | null>;
  markFilePurged(fileId: string, ownerUserId: string, completedAt?: Date): Promise<void>;
  markFilePurgeFailed(fileId: string, ownerUserId: string, errorMessage: string): Promise<void>;
  revertPendingPurgeToNone(fileId: string, ownerUserId: string): Promise<void>;
  listDueFilesForPurge(limit?: number): Promise<StoredFileLifecycleRecord[]>;
  listExpiredPurgeLeases(limit?: number): Promise<StoredFileLifecycleRecord[]>;
}

export interface FilePurgeLeaseRecoveryRepository {
  markExpiredPurgeLeaseFailed(params: {
    fileId: string;
    ownerUserId: string;
    failedAt: Date;
    errorMessage: string;
  }): Promise<StoredFileLifecycleRecord | null>;
}

export interface AccountPurgeFailureFencing {
  expectedLeaseOwner: string;
  expectedPurgeAttempts: number;
}

export type AccountPurgeFailureWriteResult =
  | { status: 'recorded'; user: UserLifecycleRecord }
  | { status: 'stale_lease'; user: UserLifecycleRecord | null };

export interface AccountPurgeRepository {
  getUserForPurge(userId: string): Promise<UserLifecycleRecord | null>;
  markUserPurging(params: {
    userId: string;
    leaseOwner: string;
    leaseSeconds: number;
    leaseUntil?: Date;
  }): Promise<UserLifecycleRecord | null>;
  markUserPurgeFailed(
    userId: string,
    errorMessage: string,
    fencing: AccountPurgeFailureFencing,
  ): Promise<AccountPurgeFailureWriteResult | void>;
  listUserStoredFiles(userId: string): Promise<StoredFileLifecycleRecord[]>;
  executeAccountPurgeRpc(userId: string, fencing: AccountPurgeFailureFencing): Promise<void>;
  listDueUsersForPurge(limit?: number): Promise<UserLifecycleRecord[]>;
  listExpiredAccountPurges(limit?: number): Promise<UserLifecycleRecord[]>;
}

export interface AccountPurgeLeaseRecoveryRepository {
  markExpiredAccountPurgeLeaseFailed(params: {
    userId: string;
    failedAt?: Date;
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

export interface ExternalIdentityOutboxRecord extends ExternalIdentityOutboxItem {
  nextAttemptAt: Date;
  leaseOwner: string | null;
  lockedUntil: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  completedAt: Date | null;
}

export interface ExternalIdentityOutboxFencing {
  expectedLeaseOwner: string;
  expectedAttemptCount: number;
}

export type ExternalIdentityOutboxClaimResult =
  | {
      status: 'acquired';
      mode: 'normal' | 'reconciliation';
      item: ExternalIdentityOutboxRecord;
    }
  | {
      status: 'unavailable';
      reason:
        | 'not_found'
        | 'already_purged'
        | 'active_lease'
        | 'retry_not_due'
        | 'max_attempts_exhausted';
      item: ExternalIdentityOutboxRecord | null;
    };

export type ExternalIdentityOutboxWriteResult =
  | { status: 'updated'; item: ExternalIdentityOutboxRecord }
  | { status: 'stale_lease'; item: ExternalIdentityOutboxRecord | null };

export interface ExternalIdentityOutboxRepository {
  getOutboxItemById(outboxId: string): Promise<ExternalIdentityOutboxRecord | null>;
  acquireOutboxLease(params: {
    outboxId: string;
    leaseOwner: string;
    leaseSeconds: number;
    allowExhaustedReconciliation?: boolean;
  }): Promise<ExternalIdentityOutboxClaimResult>;
  claimDueOutboxItems(params: {
    leaseOwner: string;
    leaseSeconds: number;
    limit?: number;
  }): Promise<ExternalIdentityOutboxRecord[]>;
  listDueExhaustedOutboxItems(params?: {
    limit?: number;
  }): Promise<ExternalIdentityOutboxRecord[]>;
  markOutboxPurged(params: {
    outboxId: string;
    fencing: ExternalIdentityOutboxFencing;
  }): Promise<ExternalIdentityOutboxWriteResult>;
  markOutboxPurgeFailed(params: {
    outboxId: string;
    retryDelaySeconds: number;
    errorCode?: string | null;
    errorMessage: string;
    fencing: ExternalIdentityOutboxFencing;
  }): Promise<ExternalIdentityOutboxWriteResult>;
}

export interface ExternalIdentityOutboxRecoveryRepository {
  markExpiredOutboxLeaseFailed(params: {
    outboxId: string;
    expectedLeaseOwner: string | null;
    expectedAttemptCount: number;
    retryDelaySeconds: number;
    errorCode?: string | null;
    errorMessage: string;
  }): Promise<ExternalIdentityOutboxWriteResult>;
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
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error('leaseSeconds must be a finite positive number.');
  }

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

  const leaseResult = await params.repo.acquireFilePurgeLeaseIfUnreferenced(
    file.id,
    params.ownerUserId,
    leaseSeconds,
  );

  if (leaseResult.status === 'blocked_by_references') {
    const blockedFile = leaseResult.file;
    if (
      blockedFile.purgeState === 'pending_purge' &&
      blockedFile.purgeAttempts === 0 &&
      !blockedFile.purgeLeaseUntil &&
      !blockedFile.lastPurgeError
    ) {
      await params.repo.revertPendingPurgeToNone(blockedFile.id, params.ownerUserId);
      return {
        fileId: blockedFile.id,
        outcome: 'reverted_blocked_by_refs',
        blockingReferences: leaseResult.blockingReferences,
      };
    }
    throw new Error(
      `Cannot purge stored_file ${blockedFile.id}: ${leaseResult.blockingReferences} active document or evidence reference(s) remain.`,
    );
  }

  if (leaseResult.status === 'unavailable') {
    const unavailableFile = leaseResult.file;
    if (
      unavailableFile &&
      unavailableFile.purgeState === 'purged' &&
      unavailableFile.uploadStatus === 'deleted'
    ) {
      return { fileId: unavailableFile.id, outcome: 'already_purged' };
    }
    if (unavailableFile && unavailableFile.purgeState === 'none') {
      return { fileId: unavailableFile.id, outcome: 'skipped_not_pending' };
    }
    if (leaseResult.reason === 'active_lease') {
      throw new Error(`Active purge lease held for stored_file ${file.id}.`);
    }
    throw new Error(`Purge lease busy for stored_file ${file.id}.`);
  }

  const leased = leaseResult.file;

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
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error('leaseSeconds must be a finite positive number.');
  }
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
    leaseSeconds,
    leaseUntil: accountLeaseUntil,
  });
  if (!claimedUser) {
    throw new Error(`Unable to claim account purge lease for user ${user.id}.`);
  }

  const acquiredLeaseOwner = claimedUser.purgeLeaseOwner ?? leaseOwner;
  const acquiredPurgeAttempts =
    claimedUser.purgeAttempts > user.purgeAttempts
      ? claimedUser.purgeAttempts
      : user.purgeAttempts + 1;

  try {
    const files = await params.accountRepo.listUserStoredFiles(user.id);
    const purgedFileIds: string[] = [];
    const alreadyPurgedFileIds: string[] = [];

    for (const file of files) {
      if (file.purgeState === 'purged' && file.uploadStatus === 'deleted') {
        alreadyPurgedFileIds.push(file.id);
        continue;
      }

      if (file.purgeState === 'none') {
        const markedPending = await params.fileRepo.markFilePendingPurge(
          file.id,
          user.id,
          params.now,
        );
        if (!markedPending) {
          throw new Error(
            `Unable to mark stored_file ${file.id} pending_purge during account purge.`,
          );
        }
      }

      const leased = await params.fileRepo.acquireFilePurgeLease(file.id, user.id, leaseSeconds);
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
        await params.fileRepo.markFilePurged(leased.id, user.id, params.now);
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

    await params.accountRepo.executeAccountPurgeRpc(user.id, {
      expectedLeaseOwner: acquiredLeaseOwner,
      expectedPurgeAttempts: acquiredPurgeAttempts,
    });

    return {
      userId: user.id,
      purgedFileIds,
      alreadyPurgedFileIds,
      databasePurgeExecuted: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Account purge failed';
    try {
      await params.accountRepo.markUserPurgeFailed(user.id, message, {
        expectedLeaseOwner: acquiredLeaseOwner,
        expectedPurgeAttempts: acquiredPurgeAttempts,
      });
    } catch {
      // Preserve the original Storage/application error even if failure persistence encounters an error.
    }
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

export function isExternalIdentityOutboxLeaseExpired(
  item: Pick<ExternalIdentityOutboxRecord, 'status' | 'lockedUntil'>,
  now: Date,
): boolean {
  if (item.status !== 'purging') {
    return false;
  }
  if (!item.lockedUntil) {
    return true;
  }
  return item.lockedUntil.getTime() <= now.getTime();
}

export type ExecuteExternalIdentityOutboxPurgeResult =
  | {
      outboxId: string;
      outcome: 'purged';
      mode: 'normal' | 'reconciliation';
      providerStatus: 'deleted' | 'already_absent';
      item: ExternalIdentityOutboxRecord;
    }
  | {
      outboxId: string;
      outcome: 'already_purged';
      item: ExternalIdentityOutboxRecord;
    }
  | {
      outboxId: string;
      outcome: 'unavailable';
      reason:
        | 'not_found'
        | 'active_lease'
        | 'retry_not_due'
        | 'max_attempts_exhausted';
      item: ExternalIdentityOutboxRecord | null;
    }
  | {
      outboxId: string;
      outcome: 'stale_lease';
      mode: 'normal' | 'reconciliation';
      providerStatus: 'deleted' | 'already_absent';
      item: ExternalIdentityOutboxRecord | null;
    };

/**
 * Durable external identity outbox orchestrator (`studexo_purge_worker` role):
 * 1. Acquires a fenced outbox lease (`mode: 'normal'` when `attempt_count < max_attempts`, or
 *    `mode: 'reconciliation'` when `allowExhaustedReconciliation: true` on a due `purge_failed`
 *    row at `attempt_count = max_attempts`).
 * 2. Invokes `SupabaseAuthAdminAdapter.deleteUserById(supabaseAuthUserId)`, treating both
 *    `'deleted'` and `'already_absent'` as confirmed external identity deletion.
 * 3. Persists completion (`markOutboxPurged`) or failure with retry backoff (`markOutboxPurgeFailed`)
 *    fenced by both `expectedLeaseOwner` (unique per-claim token) and `expectedAttemptCount`.
 */
export async function executeExternalIdentityOutboxPurge(params: {
  outboxId: string;
  leaseOwner?: string;
  leaseSeconds?: number;
  retryDelaySeconds?: number;
  allowExhaustedReconciliation?: boolean;
  repo: ExternalIdentityOutboxRepository;
  authAdmin: SupabaseAuthAdminAdapter;
}): Promise<ExecuteExternalIdentityOutboxPurgeResult> {
  const outboxId = params.outboxId?.trim();
  if (!outboxId) {
    throw new Error('outboxId must be a non-empty string.');
  }
  const leaseOwner = (params.leaseOwner ?? 'outbox-purge-worker').trim();
  if (!leaseOwner) {
    throw new Error('leaseOwner must be a non-empty string.');
  }
  const leaseSeconds = params.leaseSeconds ?? 60;
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error('leaseSeconds must be a finite positive number.');
  }
  const retryDelaySeconds = params.retryDelaySeconds ?? 60;
  if (!Number.isFinite(retryDelaySeconds) || retryDelaySeconds <= 0) {
    throw new Error('retryDelaySeconds must be a finite positive number.');
  }

  const claim = await params.repo.acquireOutboxLease({
    outboxId,
    leaseOwner,
    leaseSeconds,
    allowExhaustedReconciliation: params.allowExhaustedReconciliation,
  });

  if (claim.status === 'unavailable') {
    if (claim.reason === 'already_purged' && claim.item) {
      return {
        outboxId: claim.item.id,
        outcome: 'already_purged',
        item: claim.item,
      };
    }
    return {
      outboxId,
      outcome: 'unavailable',
      reason: claim.reason === 'already_purged' ? 'not_found' : claim.reason,
      item: claim.item,
    };
  }

  const claimed = claim.item;
  const acquiredLeaseOwner = claimed.leaseOwner?.trim();
  if (!acquiredLeaseOwner) {
    throw new Error(
      `Acquired outbox lease for ${claimed.id} is missing a valid leaseOwner token.`,
    );
  }

  const fencing: ExternalIdentityOutboxFencing = {
    expectedLeaseOwner: acquiredLeaseOwner,
    expectedAttemptCount: claimed.attemptCount,
  };

  let providerResult: { status: 'deleted' | 'already_absent' };
  try {
    providerResult = await params.authAdmin.deleteUserById(claimed.supabaseAuthUserId);
    if (
      !providerResult ||
      (providerResult.status !== 'deleted' && providerResult.status !== 'already_absent')
    ) {
      throw new Error(
        `Invalid SupabaseAuthAdminAdapter response for ${claimed.supabaseAuthUserId}.`,
      );
    }
  } catch (providerError) {
    const errorMessage =
      providerError instanceof Error && providerError.message.trim().length > 0
        ? providerError.message
        : 'External identity provider deletion failed';
    const rawCode =
      providerError &&
      typeof providerError === 'object' &&
      'code' in providerError &&
      typeof (providerError as { code?: unknown }).code === 'string'
        ? (providerError as { code: string }).code
        : 'PROVIDER_DELETE_FAILED';

    try {
      await params.repo.markOutboxPurgeFailed({
        outboxId: claimed.id,
        retryDelaySeconds,
        errorCode: rawCode,
        errorMessage,
        fencing,
      });
    } catch {
      // Preserve the original provider error even if failure persistence encounters an error.
    }
    throw providerError;
  }

  const completionWrite = await params.repo.markOutboxPurged({
    outboxId: claimed.id,
    fencing,
  });

  if (completionWrite.status === 'stale_lease') {
    return {
      outboxId: claimed.id,
      outcome: 'stale_lease',
      mode: claim.mode,
      providerStatus: providerResult.status,
      item: completionWrite.item,
    };
  }

  return {
    outboxId: claimed.id,
    outcome: 'purged',
    mode: claim.mode,
    providerStatus: providerResult.status,
    item: completionWrite.item,
  };
}

export interface RecoverExpiredExternalIdentityOutboxLeaseResult {
  outboxId: string;
  outcome:
    | 'recovered_to_purge_failed'
    | 'skipped_not_found'
    | 'skipped_terminal'
    | 'skipped_not_purging'
    | 'active_lease'
    | 'stale_lease';
  item: ExternalIdentityOutboxRecord | null;
}

/**
 * Recovers an expired `external_identity_purge_outbox.status = 'purging'` lease back to
 * `purge_failed` without stealing active leases, without modifying `purged` rows, and
 * without incrementing `attempt_count` (preserving remaining attempts and safely supporting
 * exhausted-attempt reconciliation at `attempt_count = max_attempts`).
 */
export async function recoverExpiredExternalIdentityOutboxLease(params: {
  outboxId: string;
  now?: Date;
  retryDelaySeconds?: number;
  errorCode?: string | null;
  repo: Pick<ExternalIdentityOutboxRepository, 'getOutboxItemById'> &
    ExternalIdentityOutboxRecoveryRepository;
}): Promise<RecoverExpiredExternalIdentityOutboxLeaseResult> {
  const outboxId = params.outboxId?.trim();
  if (!outboxId) {
    throw new Error('outboxId must be a non-empty string.');
  }
  const retryDelaySeconds = params.retryDelaySeconds ?? 60;
  if (!Number.isFinite(retryDelaySeconds) || retryDelaySeconds <= 0) {
    throw new Error('retryDelaySeconds must be a finite positive number.');
  }

  const item = await params.repo.getOutboxItemById(outboxId);
  if (!item) {
    return {
      outboxId,
      outcome: 'skipped_not_found',
      item: null,
    };
  }

  if (item.status === 'purged') {
    return {
      outboxId: item.id,
      outcome: 'skipped_terminal',
      item,
    };
  }

  if (item.status !== 'purging') {
    return {
      outboxId: item.id,
      outcome: 'skipped_not_purging',
      item,
    };
  }

  if (params.now && !isExternalIdentityOutboxLeaseExpired(item, params.now)) {
    return {
      outboxId: item.id,
      outcome: 'active_lease',
      item,
    };
  }

  const inspectedLeaseOwner =
    item.leaseOwner && item.leaseOwner.trim().length > 0
      ? item.leaseOwner.trim()
      : null;
  const leaseExpiryIso = item.lockedUntil ? item.lockedUntil.toISOString() : 'unset';
  const priorOwnerLabel = inspectedLeaseOwner ?? 'none';
  const defaultErrorCode =
    item.attemptCount >= item.maxAttempts
      ? 'LEASE_EXPIRED_RECONCILE_REQUIRED'
      : 'LEASE_EXPIRED';
  const errorCode =
    params.errorCode !== undefined ? params.errorCode : defaultErrorCode;
  const errorMessage =
    `Outbox purge lease (owner=${priorOwnerLabel}, attempt=${item.attemptCount}/${item.maxAttempts}) ` +
    `expired at ${leaseExpiryIso}; recovered to purge_failed`;

  const recoveryWrite = await params.repo.markExpiredOutboxLeaseFailed({
    outboxId: item.id,
    expectedLeaseOwner: inspectedLeaseOwner,
    expectedAttemptCount: item.attemptCount,
    retryDelaySeconds,
    errorCode,
    errorMessage,
  });

  if (recoveryWrite.status === 'stale_lease') {
    const latest =
      recoveryWrite.item ?? (await params.repo.getOutboxItemById(item.id));
    if (!latest) {
      return {
        outboxId: item.id,
        outcome: 'skipped_not_found',
        item: null,
      };
    }
    if (latest.status === 'purged') {
      return {
        outboxId: item.id,
        outcome: 'skipped_terminal',
        item: latest,
      };
    }
    const latestLeaseOwner =
      latest.leaseOwner && latest.leaseOwner.trim().length > 0
        ? latest.leaseOwner.trim()
        : null;
    if (
      latestLeaseOwner !== inspectedLeaseOwner ||
      latest.attemptCount !== item.attemptCount
    ) {
      return {
        outboxId: item.id,
        outcome: 'stale_lease',
        item: latest,
      };
    }
    if (latest.status === 'purging') {
      return {
        outboxId: item.id,
        outcome: 'active_lease',
        item: latest,
      };
    }
    return {
      outboxId: item.id,
      outcome: 'skipped_not_purging',
      item: latest,
    };
  }

  return {
    outboxId: recoveryWrite.item.id,
    outcome: 'recovered_to_purge_failed',
    item: recoveryWrite.item,
  };
}
