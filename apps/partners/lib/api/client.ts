import { auth } from '@/lib/firebase/client';

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'https://api.circls.app';

interface ApiErrorBody {
  error?: { code: string; message: string; details?: unknown };
}

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** fetch wrapper that attaches the Firebase ID token and unwraps the error shape. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as ApiErrorBody).error;
    throw new ApiError(e?.code ?? 'request_failed', e?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}
