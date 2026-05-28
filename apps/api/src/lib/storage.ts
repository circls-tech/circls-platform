/**
 * Object storage port (R2 / S3). Phase 11 (Track B).
 *
 * Today: in-memory STUB so the build & tests are hermetic. The real S3 client
 * lands in the same module once `R2_*` env vars are populated — only the
 * `realStorage()` branch changes; callers keep importing `getStorage()`.
 *
 * API: `presignUpload` returns a URL the partner-portal frontend PUTs to.
 *      `presignDownload` returns a short-lived GET URL for the admin viewer.
 *
 * Stub-mode caveats:
 *   - presigned URLs are `stub://<key>` and not actually fetchable.
 *   - Buffers held in process memory; restarting drops everything.
 */
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface PresignedUpload {
  /** Where the client PUTs the file. */
  uploadUrl: string;
  /** The key the client should reference after upload (e.g. when calling /kyc). */
  storageKey: string;
  /** Required headers for the PUT (e.g. Content-Type pinning). */
  headers: Record<string, string>;
  /** Seconds the URL is valid for. */
  expiresIn: number;
}

export interface PresignDownloadOptions {
  /** Force-download with this filename. */
  filenameHint?: string;
  expiresIn?: number;
}

export interface StorageAdapter {
  readonly mode: 'stub' | 'r2';
  presignUpload(input: {
    key: string;
    contentType: string;
    expiresIn?: number;
  }): Promise<PresignedUpload>;
  presignDownload(key: string, options?: PresignDownloadOptions): Promise<string>;
  /** Stub-only convenience for tests: read back what was "uploaded". */
  readForTesting?(key: string): Buffer | undefined;
  /** Stub-only convenience for tests: simulate a successful upload. */
  writeForTesting?(key: string, body: Buffer, contentType: string): void;
}

// ── Stub adapter ────────────────────────────────────────────────────────────
class StubStorage implements StorageAdapter {
  readonly mode = 'stub' as const;
  private bucket = new Map<string, { body: Buffer; contentType: string }>();

  async presignUpload(input: {
    key: string;
    contentType: string;
    expiresIn?: number;
  }): Promise<PresignedUpload> {
    return {
      uploadUrl: `stub://${input.key}`,
      storageKey: input.key,
      headers: { 'Content-Type': input.contentType },
      expiresIn: input.expiresIn ?? 600,
    };
  }

  async presignDownload(key: string, options?: PresignDownloadOptions): Promise<string> {
    const _expires = options?.expiresIn ?? 300;
    return `stub://${key}`;
  }

  readForTesting(key: string): Buffer | undefined {
    return this.bucket.get(key)?.body;
  }

  writeForTesting(key: string, body: Buffer, contentType: string): void {
    this.bucket.set(key, { body, contentType });
  }
}

// ── R2 (S3-compatible) adapter — implemented when env is set ────────────────
function realStorage(): StorageAdapter {
  // TODO(phase-11): instantiate @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner
  // pointing at `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`. Until
  // then we still return stub but log loudly so we don't ship in stub by accident.
  logger.warn(
    'storage_real_not_implemented_yet — returning stub even though R2_* env is set',
  );
  return new StubStorage();
}

let cached: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (cached) return cached;
  const haveCreds =
    env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET;
  cached = haveCreds ? realStorage() : new StubStorage();
  if (cached.mode === 'stub') logger.info('storage_mode_stub');
  return cached;
}

/** Test-only reset. */
export function __resetStorageForTesting(): void {
  cached = undefined;
}
