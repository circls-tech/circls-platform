import { z } from 'zod';

export const envSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (postgres connection string)'),
  // Firebase Admin service-account JSON (raw or base64). Optional in dev/test;
  // required at runtime once auth is exercised (GET /v1/me etc.).
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
  // Local sandbox only. When FIREBASE_AUTH_EMULATOR_HOST is set, the Admin SDK
  // routes all auth to the Firebase Auth Emulator and needs no service account
  // (see lib/firebase_admin.ts). Never set in prod.
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  // Local sandbox only. When set, outbound email is delivered to a local SMTP
  // sink (Mailpit) instead of Resend/stub (see lib/notifications/email.ts).
  // SANDBOX_SMTP_PORT's default is inert unless SANDBOX_SMTP_HOST is set.
  SANDBOX_SMTP_HOST: z.string().optional(),
  SANDBOX_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),

  // ── Track B (Phases 11–17) ─────────────────────────────────────────────────
  // All optional. When unset, the corresponding adapter runs in STUB mode:
  //   - storage   → in-memory bucket (per-process; obviously not for prod).
  //   - razorpay  → no HTTP, deterministic stub orders / refunds.
  //   - SMS/email → ledger row written, no provider call.
  // This keeps tests hermetic and lets the build go green before creds exist.

  // R2 / S3 (KYC docs, venue media). Phase 11.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),

  // Razorpay (Linked Accounts + Route + Refunds). Phases 11/12/14.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Settlement-hold buffer after a slot's end (minutes). Default = 60.
  SETTLEMENT_HOLD_BUFFER_MIN: z.coerce.number().int().min(0).default(60),
  // pending → cancelled grace period for unpaid carts (minutes).
  ABANDONED_CART_GRACE_MIN: z.coerce.number().int().min(1).default(15),

  // Notifications. Phase 13. SMS = MSG91, email = Resend, WA = AiSensy/Gupshup.
  MSG91_AUTH_KEY: z.string().optional(),
  MSG91_SENDER_ID: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(['aisensy', 'gupshup']).optional(),
  WHATSAPP_API_KEY: z.string().optional(),

  // Geocoding (venue address → lat/lng). Default 'stub' resolves against a
  // built-in IN/US city gazetteer (offline; used in the sandbox + tests). Set
  // GEOCODER_PROVIDER='nominatim' in prod to resolve arbitrary addresses via
  // OpenStreetMap Nominatim (free/keyless; ODbL permits storing results — see
  // lib/geocoding/). GEOCODER_USER_AGENT is required by Nominatim's usage policy.
  GEOCODER_PROVIDER: z.enum(['stub', 'nominatim']).default('stub'),
  GEOCODER_BASE_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  GEOCODER_USER_AGENT: z.string().default('circls-platform/1.0 (+https://circls.app)'),

  // Partner portal base URL (used to build invite acceptance links).
  PARTNERS_BASE_URL: z.string().url().default('https://partners.circls.app'),

  // Browser origins allowed to make credentialed CORS requests. Comma-separated;
  // trimmed and emptied entries dropped. Defaults to the production portals.
  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ??
        'https://admin.circls.app,https://partners.circls.app,https://circls.app,https://www.circls.app')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),

  // Admin portal base URL (used to build Circls-internal invite links).
  ADMIN_BASE_URL: z.string().url().default('https://admin.circls.app'),

  // Outbound webhooks. Phase 17.
  WEBHOOK_DELIVERY_CONCURRENCY: z.coerce.number().int().min(1).default(4),
  WEBHOOK_DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),

  // Rate limiting (M6). Global per-client per-minute ceiling, plus a stricter
  // ceiling for abuse-prone public/anonymous endpoints (hold/book/browse).
  // In-memory store → per-instance limits (fine for single-instance Coolify).
  // Disabled entirely when NODE_ENV==='test' (see server.ts allowList).
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  RATE_LIMIT_PUBLIC_MAX: z.coerce.number().int().min(1).default(60),

  // Worker process toggle (the partner-portal API container runs both web + in-proc
  // worker; if we ever split to a second Coolify service this flips false there).
  RUN_WORKER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Slug of the Circls platform tenant. Used alongside is_platform=true for
  // belt-and-suspenders lookup. Must match the row inserted by
  // src/scripts/bootstrap_circls_tenant.ts.
  CIRCLS_INTERNAL_TENANT_SLUG: z.string().default('circls-internal'),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === 'production') {
      for (const key of [
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
      ] as const) {
        if (!val[key] || val[key].length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required in production`,
          });
        }
      }
      // Sandbox-only vars must NEVER be set in production: they silently reroute
      // auth/email to local emulators that don't exist in prod. Refuse to boot.
      for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'SANDBOX_SMTP_HOST'] as const) {
        if (val[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} must not be set in production (it is a local-sandbox-only variable)`,
          });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  process.stderr.write(`Invalid environment configuration:\n${formatted}\n`);
  process.exit(1);
}

export const env: Env = parsed.data;
