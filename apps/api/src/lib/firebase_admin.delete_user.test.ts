import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit coverage for deleteFirebaseUser against the REAL module shape (only the
// Firebase Admin SDK is stubbed). The account-deletion integration tests mock
// this module wholesale, so without this file its branch logic — and the
// deliberate call ORDER — would never actually run.
const deleteUser = vi.fn(async (_uid: string) => {});
const revokeRefreshTokens = vi.fn(async (_uid: string) => {});

vi.mock('firebase-admin/app', () => ({
  getApps: () => [],
  initializeApp: vi.fn(() => ({ name: 'test-app' })),
  cert: vi.fn(() => ({ kind: 'cert' })),
}));
vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({ deleteUser, revokeRefreshTokens })),
}));
vi.mock('../config/env.js', () => ({
  env: { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099', FIREBASE_PROJECT_ID: 'demo-circls' },
}));

const { deleteFirebaseUser } = await import('./firebase_admin.js');

/** Firebase Admin surfaces failures as an Error carrying a string `code`. */
function firebaseError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('deleteFirebaseUser', () => {
  beforeEach(() => {
    deleteUser.mockClear();
    revokeRefreshTokens.mockClear();
    deleteUser.mockImplementation(async () => {});
  });

  it('deletes the account', async () => {
    await deleteFirebaseUser('uid_1');
    expect(deleteUser).toHaveBeenCalledWith('uid_1');
  });

  /**
   * REGRESSION GUARD (review of PR #173, Critical 1). Revoking before deleting
   * looks harmless but is not: `verifyIdToken` runs with checkRevoked=true, so a
   * revoke that lands ahead of a FAILED deleteUser kills the caller's token and
   * their retry is rejected at `requireAuth` before it can ever reach the
   * deletion handler — stranding the Firebase account, and the PII on it,
   * forever. Nothing here may revoke.
   */
  it('never revokes refresh tokens — that would break the retry path', async () => {
    await deleteFirebaseUser('uid_1');
    expect(revokeRefreshTokens).not.toHaveBeenCalled();

    deleteUser.mockImplementation(async () => {
      throw firebaseError('auth/internal-error');
    });
    await expect(deleteFirebaseUser('uid_1')).rejects.toThrow();
    expect(revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it('swallows auth/user-not-found so a retry is idempotent', async () => {
    deleteUser.mockImplementation(async () => {
      throw firebaseError('auth/user-not-found');
    });
    await expect(deleteFirebaseUser('uid_gone')).resolves.toBeUndefined();
  });

  it('propagates every other Firebase error so the caller can 502', async () => {
    deleteUser.mockImplementation(async () => {
      throw firebaseError('auth/internal-error');
    });
    await expect(deleteFirebaseUser('uid_1')).rejects.toMatchObject({
      code: 'auth/internal-error',
    });
  });
});
