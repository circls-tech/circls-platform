/**
 * API keys service (Phase 17).
 *
 * Tokens look like `ck_test_<32-base64url>` or `ck_live_<32-base64url>`. Key is
 * shown to the caller exactly once on create; only `key_hash` (bcrypt) and a
 * lookup-friendly `key_prefix` (first 12 chars of the plaintext, indexed) are
 * persisted. Verification: SELECT all active rows with that prefix, then
 * bcrypt-compare the plaintext against each row's hash.
 */
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiKeys, type ApiKey } from '../db/schema/api_keys.js';
import { env } from '../config/env.js';
import { writeAudit, writeSystemAudit } from '../lib/audit.js';
import { getPlatformTenantId } from '../lib/authz/platform_tenant.js';

const BCRYPT_ROUNDS = 10;
const PREFIX_LEN = 12;

export interface CreateApiKeyInput {
  tenantId: string | null;
  /** The user creating the key — used for the audit trail. May be null for ops-issued platform keys. */
  actorUserId?: string | null;
  name: string;
  role: 'read' | 'write' | 'admin';
  scopes?: string[] | undefined;
}

export interface CreateApiKeyResult {
  id: string;
  /** Full plaintext key — returned to the caller exactly once. */
  plaintext: string;
  prefix: string;
}

function makePlaintext(): string {
  const tag = env.NODE_ENV === 'production' ? 'live' : 'test';
  // 24 random bytes → 32 chars of base64url.
  const random = crypto.randomBytes(24).toString('base64url');
  return `ck_${tag}_${random}`;
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const plaintext = makePlaintext();
  const prefix = plaintext.slice(0, PREFIX_LEN);
  const keyHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);

  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId: input.tenantId,
      name: input.name,
      keyHash,
      keyPrefix: prefix,
      role: input.role,
      scopes: input.scopes ?? [],
    })
    .returning();

  if (!row) throw new Error('api_key_insert_failed');

  // Audit trail — ALWAYS write a row, including for ops-issued platform keys
  // (tenantId === null). Tenant-scoped keys audit against their own tenant;
  // platform keys audit against the Circls platform tenant. The actor is the
  // creating user, or null for fully system-issued keys (the column is
  // nullable). Never silently skip auditing key creation.
  const auditTenantId = input.tenantId ?? (await getPlatformTenantId());
  await writeSystemAudit(
    db,
    { tenantId: auditTenantId, actorUserId: input.actorUserId ?? null },
    'api_key.created',
    'api_key',
    row.id,
    null,
    {
      name: row.name,
      role: row.role,
      scopes: row.scopes,
      prefix,
      // Record whether this was a platform (null-tenant) key for traceability.
      platformKey: input.tenantId === null,
    },
  );

  return { id: row.id, plaintext, prefix };
}

export async function revokeApiKey(
  keyId: string,
  tenantId: string | null,
  actorUserId?: string | null,
): Promise<void> {
  // For tenant-scoped revokes, require tenant_id match to prevent cross-tenant revoke.
  // Platform-scoped (tenantId === null) keys can only be revoked by passing
  // tenantId === null explicitly (caller responsibility: gate this with a platform
  // admin check before invoking).
  const whereClause = tenantId === null
    ? and(eq(apiKeys.id, keyId), sql`${apiKeys.tenantId} is null`)
    : and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId));

  const [row] = await db
    .update(apiKeys)
    .set({ status: 'revoked' })
    .where(whereClause)
    .returning();

  if (!row) return; // already revoked / not found — idempotent

  if (tenantId && actorUserId) {
    await writeAudit(
      db,
      { tenantId, actorUserId },
      'api_key.revoked',
      'api_key',
      row.id,
      { status: 'active' },
      { status: 'revoked' },
    );
  }
}

export async function verifyApiKey(plaintext: string): Promise<ApiKey | null> {
  if (typeof plaintext !== 'string' || plaintext.length < PREFIX_LEN + 4) return null;
  const prefix = plaintext.slice(0, PREFIX_LEN);

  const candidates = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.status, 'active')));

  for (const row of candidates) {
    // bcrypt.compare is constant-time per hash; iterating is safe (and the
    // collision space is astronomical, so candidates.length is ~1 in practice).
    // eslint-disable-next-line no-await-in-loop
    const ok = await bcrypt.compare(plaintext, row.keyHash);
    if (ok) {
      // Best-effort last_used_at touch (don't fail the request if this UPDATE
      // races with a revoke).
      void db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.id))
        .catch(() => {});
      return row;
    }
  }
  return null;
}

export async function listApiKeys(tenantId: string | null): Promise<ApiKey[]> {
  if (tenantId === null) {
    return db.select().from(apiKeys).where(sql`${apiKeys.tenantId} is null`);
  }
  return db.select().from(apiKeys).where(and(eq(apiKeys.tenantId, tenantId)));
}
