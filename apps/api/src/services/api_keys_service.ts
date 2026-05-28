/**
 * API keys service stub — Phase 17 owner fills these in.
 *
 * Tokens look like `ck_test_<32-random>` or `ck_live_<32-random>`. Key shown
 * once on create; only key_hash (bcrypt) persisted. `keyPrefix` = first 12
 * chars (e.g. `ck_test_4Kj9`) is indexed for fast lookup; we then bcrypt-compare
 * the full token against the matching row's `key_hash`.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { apiKeys, type ApiKey } from '../db/schema/api_keys.js';

export interface CreateApiKeyInput {
  tenantId: string | null;
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

export async function createApiKey(_input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  throw new Error('api_keys_service.createApiKey not implemented — phase 17');
}

export async function revokeApiKey(_keyId: string, _tenantId: string | null): Promise<void> {
  throw new Error('api_keys_service.revokeApiKey not implemented — phase 17');
}

export async function verifyApiKey(_plaintext: string): Promise<ApiKey | null> {
  throw new Error('api_keys_service.verifyApiKey not implemented — phase 17');
}

export async function listApiKeys(tenantId: string | null): Promise<ApiKey[]> {
  // List call works fine without the auth machinery, so we leave it real.
  if (tenantId === null) {
    return db.select().from(apiKeys).where(eq(apiKeys.tenantId, null as unknown as string));
  }
  return db.select().from(apiKeys).where(and(eq(apiKeys.tenantId, tenantId)));
}
