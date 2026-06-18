import { afterEach, describe, expect, it, vi } from 'vitest';

// We test the branch logic of app() by mocking firebase-admin/app and the env.
const initializeApp = vi.fn(() => ({ name: 'test-app' }));
const cert = vi.fn(() => ({ kind: 'cert' }));
vi.mock('firebase-admin/app', () => ({
  getApps: () => [],
  initializeApp,
  cert,
}));
vi.mock('firebase-admin/auth', () => ({ getAuth: vi.fn() }));

afterEach(() => {
  vi.resetModules();
  initializeApp.mockClear();
  cert.mockClear();
});

describe('firebase_admin app() emulator branch', () => {
  it('initializes with projectId only when the emulator host is set', async () => {
    vi.doMock('../config/env.js', () => ({
      env: { FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099', FIREBASE_PROJECT_ID: 'demo-circls' },
    }));
    const mod = await import('./firebase_admin.js');
    mod.firebaseAuth();
    expect(initializeApp).toHaveBeenCalledWith({ projectId: 'demo-circls' });
    expect(cert).not.toHaveBeenCalled();
  });

  it('throws when neither emulator host nor service account is set', async () => {
    vi.doMock('../config/env.js', () => ({ env: {} }));
    const mod = await import('./firebase_admin.js');
    expect(() => mod.firebaseAuth()).toThrow('FIREBASE_SERVICE_ACCOUNT is not configured');
  });
});
