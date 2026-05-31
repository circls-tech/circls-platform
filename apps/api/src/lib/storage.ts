/**
 * Object storage port (R2 / S3). Phase 11 (Track B).
 *
 * Two modes, selected by env at first `getStorage()`:
 *   - STUB  (no R2_* creds): in-memory bucket; hermetic for build & tests.
 *   - R2    (creds present): real Cloudflare R2 over the S3 API.
 *
 * Upload is always a presigned PUT straight to R2 — the API process never
 * touches the bytes. Public-facing media (venue photos) is read via a plain
 * CDN-cacheable URL built from `publicUrl()`; private media (e.g. KYC, future)
 * is read via a short-lived presigned GET from `presignDownload()`.
 *
 * SECURITY: the bucket pointed at by R2_* here is the PUBLIC venue-media bucket.
 * Do NOT route private documents (KYC, IDs) through it — those get their own
 * private bucket + adapter when that feature lands.
 *
 * Stub-mode caveats:
 *   - presigned URLs are `stub://<key>` and not actually fetchable.
 *   - Buffers held in process memory; restarting drops everything.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

/** Metadata read back from the store after an upload completes. */
export interface ObjectHead {
  sizeBytes: number;
  contentType: string;
}

export interface StorageAdapter {
  readonly mode: 'stub' | 'r2';
  presignUpload(input: {
    key: string;
    contentType: string;
    expiresIn?: number;
  }): Promise<PresignedUpload>;
  presignDownload(key: string, options?: PresignDownloadOptions): Promise<string>;
  /** Public, CDN-cacheable read URL for an object (public buckets only). */
  publicUrl(key: string): string;
  /** HEAD the object; returns null if it does not exist. Used to verify uploads. */
  head(key: string): Promise<ObjectHead | null>;
  /** Delete the object. No-op if absent. */
  delete(key: string): Promise<void>;
  /** Stub-only convenience for tests: read back what was "uploaded". */
  readForTesting?(key: string): Buffer | undefined;
  /** Stub-only convenience for tests: simulate a successful upload. */
  writeForTesting?(key: string, body: Buffer, contentType: string): void;
}

/** Trim a single trailing slash so `${base}/${key}` never doubles up. */
function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
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

  publicUrl(key: string): string {
    const base = env.R2_PUBLIC_BASE_URL ? trimTrailingSlash(env.R2_PUBLIC_BASE_URL) : 'stub://public';
    return `${base}/${key}`;
  }

  async head(key: string): Promise<ObjectHead | null> {
    const obj = this.bucket.get(key);
    if (!obj) return null;
    return { sizeBytes: obj.body.length, contentType: obj.contentType };
  }

  async delete(key: string): Promise<void> {
    this.bucket.delete(key);
  }

  readForTesting(key: string): Buffer | undefined {
    return this.bucket.get(key)?.body;
  }

  writeForTesting(key: string, body: Buffer, contentType: string): void {
    this.bucket.set(key, { body, contentType });
  }
}

// ── R2 (S3-compatible) adapter ──────────────────────────────────────────────
class R2Storage implements StorageAdapter {
  readonly mode = 'r2' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBase: string | undefined;

  constructor(opts: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicBaseUrl: string | undefined;
  }) {
    this.bucket = opts.bucket;
    this.publicBase = opts.publicBaseUrl ? trimTrailingSlash(opts.publicBaseUrl) : undefined;
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      },
    });
  }

  async presignUpload(input: {
    key: string;
    contentType: string;
    expiresIn?: number;
  }): Promise<PresignedUpload> {
    const expiresIn = input.expiresIn ?? 600;
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    const uploadUrl = await getSignedUrl(this.client, cmd, { expiresIn });
    return {
      uploadUrl,
      storageKey: input.key,
      // The client MUST send the same Content-Type it was presigned with,
      // otherwise R2 rejects the PUT with a signature mismatch.
      headers: { 'Content-Type': input.contentType },
      expiresIn,
    };
  }

  async presignDownload(key: string, options?: PresignDownloadOptions): Promise<string> {
    const expiresIn = options?.expiresIn ?? 300;
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options?.filenameHint
        ? { ResponseContentDisposition: `attachment; filename="${options.filenameHint}"` }
        : {}),
    });
    return getSignedUrl(this.client, cmd, { expiresIn });
  }

  publicUrl(key: string): string {
    if (!this.publicBase) {
      throw new Error('R2_PUBLIC_BASE_URL is not set — cannot build a public URL for venue media');
    }
    return `${this.publicBase}/${key}`;
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: res.ContentLength ?? 0,
        contentType: res.ContentType ?? 'application/octet-stream',
      };
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function realStorage(): StorageAdapter {
  if (!env.R2_PUBLIC_BASE_URL) {
    logger.warn(
      'storage_r2_no_public_base_url — venue-media public URLs will fail until R2_PUBLIC_BASE_URL is set',
    );
  }
  logger.info('storage_mode_r2');
  return new R2Storage({
    accountId: env.R2_ACCOUNT_ID!,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: env.R2_BUCKET!,
    publicBaseUrl: env.R2_PUBLIC_BASE_URL,
  });
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
