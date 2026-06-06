import { type App, type ServiceAccount, cert, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, type DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { env } from '../config/env.js';

/**
 * Parses FIREBASE_SERVICE_ACCOUNT (raw JSON or base64-encoded JSON) into the
 * camelCase shape `cert()` wants, repairing escaped newlines in the private key
 * (common when the JSON is squeezed into a single env var).
 */
function loadServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const json = JSON.parse(text) as Record<string, string | undefined>;
  const projectId = json.project_id ?? json.projectId;
  const clientEmail = json.client_email ?? json.clientEmail;
  const privateKey = (json.private_key ?? json.privateKey)?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT missing project_id / client_email / private_key');
  }
  return { projectId, clientEmail, privateKey };
}

let cached: App | undefined;

function app(): App {
  if (cached) return cached;
  const existing = getApps();
  if (existing[0]) {
    cached = existing[0];
    return cached;
  }
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  }
  cached = initializeApp({ credential: cert(loadServiceAccount(env.FIREBASE_SERVICE_ACCOUNT)) });
  return cached;
}

export function firebaseAuth(): Auth {
  return getAuth(app());
}

/** Verify a Firebase ID token; throws if invalid/expired/revoked. */
export async function verifyIdToken(token: string): Promise<DecodedIdToken> {
  // checkRevoked=true so revoked/disabled accounts are rejected immediately
  // instead of staying valid until token expiry (≤1h). This costs an extra
  // Firebase lookup per request, which is acceptable at the current scale and
  // closes the revocation gap (M5).
  return firebaseAuth().verifyIdToken(token, true);
}
