# Local Team Sandbox + PR-only Guardrails — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each non-technical team member a one-command, fully-containerized local Circls stack (all third-party services simulated offline) whose changes can only ever reach the canonical repo as pull requests — never `main`/`release`.

**Architecture:** A `compose.sandbox.yaml` brings up Postgres + the Firebase Auth Emulator + Mailpit + all four apps (dev-mode, repo bind-mounted for hot reload). Three small, env-gated, prod-invisible code changes route auth to the emulator and email to Mailpit; Razorpay/R2 already free-run as offline stubs. A `./sandbox` wrapper provides `setup/up/down/reset/seed/logs`. Guardrails are layered: the **fork model** is the unbypassable server-side wall (members have no write to upstream), backed by a committed `pre-push` git hook, Claude Code `deny`-rules + a `PreToolUse` hook, and a `CLAUDE.md` sandbox section.

**Tech Stack:** Node 24 + pnpm 9 workspaces, Fastify (api), Next.js 15 (partners/admin/consumer), Postgres 18 + Drizzle, firebase-tools Auth Emulator, Mailpit, nodemailer, Docker Compose, GitHub fork PRs.

**Spec:** `docs/superpowers/specs/2026-06-18-local-team-sandbox-design.md`

---

## File map (what gets created / modified)

**Code changes (env-gated, default-off — prod & CI unaffected):**
- Modify `apps/api/src/config/env.ts` — add `FIREBASE_AUTH_EMULATOR_HOST`, `FIREBASE_PROJECT_ID`, `SANDBOX_SMTP_HOST`, `SANDBOX_SMTP_PORT`.
- Modify `apps/api/src/lib/firebase_admin.ts` — emulator branch in `app()`.
- Modify `apps/api/src/lib/notifications/email.ts` — `SmtpEmail` provider (→ Mailpit).
- Modify `apps/api/package.json` — add `nodemailer` dep + `seed:sandbox` script.
- Create `apps/api/src/lib/firebase_admin.emulator.test.ts` — regression test.
- Create `apps/api/src/lib/notifications/email.smtp.test.ts` — provider-selection test.
- Modify `apps/partners/lib/firebase/client.ts`, `apps/admin/lib/firebase/client.ts`, `apps/consumer/lib/firebase/client.ts` — `connectAuthEmulator` hook.

**Sandbox infra (new, self-contained):**
- Create `firebase.json` — Auth emulator config.
- Create `sandbox/Dockerfile.dev` — dev image (deps baked, source bind-mounted at run).
- Create `sandbox/firebase-emulator/Dockerfile` — firebase-tools image.
- Create `compose.sandbox.yaml` — the full local stack.
- Create `sandbox/env/api.env`, `sandbox/env/partners.env`, `sandbox/env/admin.env`, `sandbox/env/consumer.env` — sandbox env files.
- Create `apps/api/src/scripts/seed_sandbox.ts` — emulator users + demo Postgres data.
- Create `sandbox` (executable wrapper script at repo root).

**Guardrails (new):**
- Create `.githooks/pre-push` — block pushes to `main`/`release`, force-push, deletes.
- Create `.claude/settings.json` — `deny` rules + `PreToolUse` hook registration.
- Create `.claude/hooks/guard-git.sh` — parses git/`gh` commands, blocks dangerous ones.
- Modify `CLAUDE.md` — add a "Sandbox & contribution rules" section.
- Create `SANDBOX.md` — plain-language onboarding for non-devs.

---

## Task 1: API env — sandbox config keys

**Files:**
- Modify: `apps/api/src/config/env.ts`

- [ ] **Step 1: Add the four optional keys to the zod schema**

In `apps/api/src/config/env.ts`, immediately after the `FIREBASE_SERVICE_ACCOUNT` line (currently line 13), add:

```ts
  // Local sandbox only. When FIREBASE_AUTH_EMULATOR_HOST is set, the Admin SDK
  // routes all auth to the Firebase Auth Emulator and needs no service account
  // (see lib/firebase_admin.ts). Never set in prod.
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  // Local sandbox only. When set, outbound email is delivered to a local SMTP
  // sink (Mailpit) instead of Resend/stub (see lib/notifications/email.ts).
  SANDBOX_SMTP_HOST: z.string().optional(),
  SANDBOX_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
```

- [ ] **Step 2: Verify the schema still type-checks**

Run: `pnpm --filter @circls/api typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/config/env.ts
git commit -m "feat(api): add sandbox env keys (firebase emulator + smtp sink)"
```

---

## Task 2: API Firebase Admin — Auth Emulator branch

**Files:**
- Modify: `apps/api/src/lib/firebase_admin.ts:27-37` (the `app()` function)
- Test: `apps/api/src/lib/firebase_admin.emulator.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/firebase_admin.emulator.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @circls/api test -- firebase_admin.emulator`
Expected: FAIL — the first test fails because `initializeApp` is currently only called with `{ credential: ... }`, never `{ projectId }`.

- [ ] **Step 3: Add the emulator branch**

In `apps/api/src/lib/firebase_admin.ts`, replace the body of `app()` (the block starting `if (!env.FIREBASE_SERVICE_ACCOUNT)`) so it reads:

```ts
function app(): App {
  if (cached) return cached;
  const existing = getApps();
  if (existing[0]) {
    cached = existing[0];
    return cached;
  }
  // Local sandbox: when the Auth Emulator host is set, the Admin SDK auto-routes
  // all auth calls to the emulator (it reads FIREBASE_AUTH_EMULATOR_HOST from the
  // process env itself) and needs only a projectId — no service-account cert.
  // This branch is never taken in prod, where the var is unset.
  if (env.FIREBASE_AUTH_EMULATOR_HOST) {
    cached = initializeApp({ projectId: env.FIREBASE_PROJECT_ID ?? 'demo-circls' });
    return cached;
  }
  if (!env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not configured');
  }
  cached = initializeApp({ credential: cert(loadServiceAccount(env.FIREBASE_SERVICE_ACCOUNT)) });
  return cached;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @circls/api test -- firebase_admin.emulator`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full api typecheck**

Run: `pnpm --filter @circls/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/firebase_admin.ts apps/api/src/lib/firebase_admin.emulator.test.ts
git commit -m "feat(api): route auth to Firebase emulator when FIREBASE_AUTH_EMULATOR_HOST is set"
```

---

## Task 3: API email — Mailpit SMTP provider

**Files:**
- Modify: `apps/api/package.json` (add `nodemailer`)
- Modify: `apps/api/src/lib/notifications/email.ts`
- Test: `apps/api/src/lib/notifications/email.smtp.test.ts` (create)

- [ ] **Step 1: Add the nodemailer dependency**

Run:
```bash
pnpm --filter @circls/api add nodemailer && pnpm --filter @circls/api add -D @types/nodemailer
```
Expected: `nodemailer` appears in `apps/api/package.json` dependencies and `@types/nodemailer` in devDependencies.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/lib/notifications/email.smtp.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({ messageId: '<sandbox-1@mailpit>' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}));

afterEach(() => {
  vi.resetModules();
  sendMail.mockClear();
});

describe('getEmailProvider SMTP selection', () => {
  it('uses the SMTP provider when SANDBOX_SMTP_HOST is set', async () => {
    vi.doMock('../../config/env.js', () => ({
      env: { SANDBOX_SMTP_HOST: 'mailpit', SANDBOX_SMTP_PORT: 1025, RESEND_FROM: 'Sandbox <no-reply@local>' },
    }));
    const { getEmailProvider } = await import('./email.js');
    const provider = getEmailProvider();
    expect(provider.mode).toBe('smtp');
    await provider.send({ recipient: 'a@b.com', templateKey: 'invitation', payload: {} as never });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it('falls back to stub when nothing is configured', async () => {
    vi.doMock('../../config/env.js', () => ({ env: {} }));
    const { getEmailProvider } = await import('./email.js');
    expect(getEmailProvider().mode).toBe('stub');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @circls/api test -- email.smtp`
Expected: FAIL — `provider.mode` is `'stub'`, not `'smtp'` (the SMTP provider does not exist yet).

- [ ] **Step 4: Add the SMTP provider**

In `apps/api/src/lib/notifications/email.ts`:

(a) Add the import at the top (after the existing imports):
```ts
import nodemailer from 'nodemailer';
```

(b) Widen the `EmailProvider.mode` union (line 7) to:
```ts
  readonly mode: 'stub' | 'resend' | 'smtp';
```

(c) Add this class after `class StubEmail { … }` (before `class ResendEmail`):
```ts
/**
 * Local sandbox only. Delivers to a local SMTP sink (Mailpit) so non-dev team
 * members can read the exact rendered email at the Mailpit web inbox instead of
 * it being silently logged. Selected when SANDBOX_SMTP_HOST is set.
 */
class SmtpEmail implements EmailProvider {
  readonly mode = 'smtp' as const;
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(
    host: string,
    port: number,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({ host, port, secure: false });
  }
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    const rendered = renderTemplate('email', input.templateKey, input.payload);
    const info = await this.transport.sendMail({
      from: this.from,
      to: input.recipient,
      subject: rendered.subject ?? '(no subject)',
      text: rendered.body,
    });
    return { providerMessageId: info.messageId };
  }
}
```

(d) At the top of `getEmailProvider()` (before the `RESEND_API_KEY && RESEND_FROM` check), add:
```ts
  // Local sandbox short-circuit: deliver to the Mailpit SMTP sink.
  if (env.SANDBOX_SMTP_HOST) {
    return new SmtpEmail(env.SANDBOX_SMTP_HOST, env.SANDBOX_SMTP_PORT, env.RESEND_FROM ?? 'Circls Sandbox <no-reply@sandbox.local>');
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @circls/api test -- email.smtp`
Expected: PASS (both tests).

- [ ] **Step 6: Run the existing notifications tests to confirm no regression**

Run: `pnpm --filter @circls/api test -- notifications`
Expected: PASS (existing `index.test.ts`, `templates.test.ts`, `notification_service.test.ts` all still green).

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json apps/api/src/lib/notifications/email.ts apps/api/src/lib/notifications/email.smtp.test.ts pnpm-lock.yaml
git commit -m "feat(api): SMTP (Mailpit) email provider for the local sandbox"
```

---

## Task 4: Frontend — connect to the Auth Emulator

**Files:**
- Modify: `apps/partners/lib/firebase/client.ts`
- Modify: `apps/admin/lib/firebase/client.ts`
- Modify: `apps/consumer/lib/firebase/client.ts`

> These three files are intentional copies of each other (see their header comment). Apply the identical edit to each — do not extract a shared package (out of scope; would touch the workspace graph).

- [ ] **Step 1: Edit `apps/partners/lib/firebase/client.ts`**

Change the import line:
```ts
import { getAuth } from 'firebase/auth';
```
to:
```ts
import { connectAuthEmulator, getAuth } from 'firebase/auth';
```

Then replace the final line:
```ts
export const auth = getAuth(firebaseApp);
```
with:
```ts
export const auth = getAuth(firebaseApp);

// Local sandbox only: point the web SDK at the Firebase Auth Emulator so phone
// OTPs are shown (in the emulator UI / logs) instead of texted, and no real
// project is touched. Gated by NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1; never on in
// prod. Browser-only (the emulator host is reachable from the user's machine).
if (process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATOR === '1' && typeof window !== 'undefined') {
  connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
}
```

- [ ] **Step 2: Apply the identical edit to `apps/admin/lib/firebase/client.ts` and `apps/consumer/lib/firebase/client.ts`**

Same two changes (import + the appended emulator block) in both files.

- [ ] **Step 3: Typecheck all three apps**

Run: `pnpm --filter @circls/partners --filter @circls/admin --filter @circls/consumer typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/partners/lib/firebase/client.ts apps/admin/lib/firebase/client.ts apps/consumer/lib/firebase/client.ts
git commit -m "feat(web): connect to Firebase Auth Emulator when NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1"
```

---

## Task 5: Firebase Auth Emulator config + image

**Files:**
- Create: `firebase.json`
- Create: `sandbox/firebase-emulator/Dockerfile`

- [ ] **Step 1: Create `firebase.json` at repo root**

```json
{
  "emulators": {
    "auth": { "host": "0.0.0.0", "port": 9099 },
    "ui": { "enabled": true, "host": "0.0.0.0", "port": 4000 },
    "singleProjectMode": true
  }
}
```

- [ ] **Step 2: Create `sandbox/firebase-emulator/Dockerfile`**

```dockerfile
# Firebase Auth Emulator only. The Auth emulator needs no JRE (unlike
# Firestore/RTDB), so this stays a thin node image. The Emulator UI bundle is
# fetched at build time so container start is offline-friendly.
FROM node:24-alpine
RUN apk add --no-cache bash openjdk17-jre-headless && \
    npm install -g firebase-tools@13
WORKDIR /srv
COPY firebase.json ./firebase.json
RUN firebase setup:emulators:ui || true
EXPOSE 9099 4000
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "demo-circls"]
```
> `openjdk17-jre-headless` is included because the Emulator UI's bundled tooling can require it on some firebase-tools versions; it keeps the image robust. The `demo-` project prefix tells the emulator this is an offline demo project (no real credentials, never reaches production).

- [ ] **Step 3: Verify the image builds**

Run: `docker build -f sandbox/firebase-emulator/Dockerfile -t circls-fb-emulator .`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add firebase.json sandbox/firebase-emulator/Dockerfile
git commit -m "feat(sandbox): firebase auth emulator config + image"
```

---

## Task 6: Dev image for the app services

**Files:**
- Create: `sandbox/Dockerfile.dev`
- Create: `sandbox/.dockerignore` (optional, speeds build)

- [ ] **Step 1: Create `sandbox/Dockerfile.dev`**

```dockerfile
# Dev image for all four app services. Dependencies are installed into the image
# so node_modules can be masked by (image-initialized) anonymous volumes at run
# time, while the repo source is bind-mounted for hot reload. Rebuild when deps
# change: `./sandbox build`.
FROM node:24-alpine
RUN apk add --no-cache bash && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
EXPOSE 8080 3001 3002 3003
# Each compose service overrides `command`.
CMD ["sh", "-c", "echo 'override me'"]
```

- [ ] **Step 2: Create `sandbox/.dockerignore`**

```
node_modules
**/node_modules
**/.next
**/dist
.git
.claude/worktrees
```

- [ ] **Step 3: Verify the dev image builds**

Run: `docker build -f sandbox/Dockerfile.dev -t circls-sandbox-dev .`
Expected: build succeeds (pnpm install completes).

- [ ] **Step 4: Commit**

```bash
git add sandbox/Dockerfile.dev sandbox/.dockerignore
git commit -m "feat(sandbox): dev image with baked deps for bind-mounted hot reload"
```

---

## Task 7: Sandbox env files

**Files:**
- Create: `sandbox/env/api.env`
- Create: `sandbox/env/partners.env`
- Create: `sandbox/env/admin.env`
- Create: `sandbox/env/consumer.env`

> No real keys appear anywhere here. Razorpay/R2 keys are intentionally absent → backend stub mode. Firebase points at the emulator. These files are safe to commit.

- [ ] **Step 1: Create `sandbox/env/api.env`**

```
NODE_ENV=development
PORT=8080
LOG_LEVEL=info
DATABASE_URL=postgres://postgres:postgres@postgres:5432/circls
FIREBASE_AUTH_EMULATOR_HOST=firebase-emulator:9099
FIREBASE_PROJECT_ID=demo-circls
SANDBOX_SMTP_HOST=mailpit
SANDBOX_SMTP_PORT=1025
RESEND_FROM=Circls Sandbox <no-reply@sandbox.local>
CORS_ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3002,http://localhost:3003
PARTNERS_BASE_URL=http://localhost:3001
ADMIN_BASE_URL=http://localhost:3002
```

- [ ] **Step 2: Create `sandbox/env/partners.env`**

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:8080
NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-circls
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-circls.firebaseapp.com
NEXT_PUBLIC_FIREBASE_API_KEY=demo-key
NEXT_PUBLIC_FIREBASE_USE_EMULATOR=1
```

- [ ] **Step 3: Create `sandbox/env/admin.env` and `sandbox/env/consumer.env`**

Identical to `partners.env` (same five vars). The per-app file exists so members can diverge them later if needed.

- [ ] **Step 4: Commit**

```bash
git add sandbox/env/
git commit -m "feat(sandbox): env files (emulator + stubbed third parties, no real keys)"
```

---

## Task 8: compose.sandbox.yaml

**Files:**
- Create: `compose.sandbox.yaml`

- [ ] **Step 1: Create `compose.sandbox.yaml` at repo root**

```yaml
# Local team sandbox — full Circls stack, all third parties simulated offline.
# Driven by ./sandbox. NOT for production.
name: circls-sandbox

x-dev: &dev
  build:
    context: .
    dockerfile: sandbox/Dockerfile.dev
  restart: unless-stopped
  depends_on:
    postgres:
      condition: service_healthy
    firebase-emulator:
      condition: service_started

services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: circls
    ports: ['5433:5432']
    volumes:
      - sandbox_pgdata:/var/lib/postgresql
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d circls']
      interval: 5s
      timeout: 3s
      retries: 20

  firebase-emulator:
    build:
      context: .
      dockerfile: sandbox/firebase-emulator/Dockerfile
    ports:
      - '9099:9099'   # auth
      - '4000:4000'   # emulator UI (shows OTP codes + users)
    restart: unless-stopped

  mailpit:
    image: axllent/mailpit:latest
    ports:
      - '8025:8025'   # web inbox
      - '1025:1025'   # SMTP
    restart: unless-stopped

  api:
    <<: *dev
    env_file: ./sandbox/env/api.env
    command: sh -c "pnpm --filter @circls/api db:migrate && pnpm --filter @circls/api dev"
    ports: ['8080:8080']
    volumes:
      - .:/repo
      - /repo/node_modules
      - /repo/apps/api/node_modules

  partners:
    <<: *dev
    env_file: ./sandbox/env/partners.env
    command: pnpm --filter @circls/partners dev
    ports: ['3001:3001']
    volumes:
      - .:/repo
      - /repo/node_modules
      - /repo/apps/partners/node_modules
      - /repo/apps/partners/.next
      - /repo/packages/ui-kit/node_modules
      - /repo/packages/api-types/node_modules

  admin:
    <<: *dev
    env_file: ./sandbox/env/admin.env
    command: pnpm --filter @circls/admin dev
    ports: ['3002:3002']
    volumes:
      - .:/repo
      - /repo/node_modules
      - /repo/apps/admin/node_modules
      - /repo/apps/admin/.next
      - /repo/packages/ui-kit/node_modules
      - /repo/packages/api-types/node_modules

  consumer:
    <<: *dev
    env_file: ./sandbox/env/consumer.env
    command: pnpm --filter @circls/consumer dev
    ports: ['3003:3003']
    volumes:
      - .:/repo
      - /repo/node_modules
      - /repo/apps/consumer/node_modules
      - /repo/apps/consumer/.next
      - /repo/packages/ui-kit/node_modules
      - /repo/packages/api-types/node_modules

volumes:
  sandbox_pgdata:
```

> The bare `/repo/...node_modules` volume entries are anonymous volumes: Docker initializes each from the image's contents at that path (deps baked in Task 6), so the `.:/repo` bind mount provides live source for hot reload without clobbering installed deps. `.next` dirs are likewise kept out of the bind mount so the host and container don't fight over build output.
>
> Network note: `NEXT_PUBLIC_API_BASE_URL=http://localhost:8080` is correct because the apps fetch the API **client-side** (React Query hooks run in the browser, which reaches the host-published `:8080`). If any page does server-side fetching to the API and fails inside the container, add a server-only `API_INTERNAL_URL=http://api:8080` and use it in server code — but the current apps are client-fetch, so this is not expected to be needed.

- [ ] **Step 2: Confirm each app's dev script binds to 0.0.0.0 and the expected port**

Run: `cat apps/partners/package.json apps/admin/package.json apps/consumer/package.json | grep -A1 '"dev"'`
Expected: each `dev` script is `next dev` on its port (3001/3002/3003). If any `next dev` lacks an explicit port, add `-p 3001` (etc.) and `-H 0.0.0.0` to that app's `dev` script and commit it with this task. (Next.js binds all interfaces by default in dev, so `-H` is usually unnecessary; the port must be correct.)

- [ ] **Step 3: Commit**

```bash
git add compose.sandbox.yaml
git commit -m "feat(sandbox): compose stack (pg + auth emulator + mailpit + 4 apps)"
```

---

## Task 9: Sandbox seed script

**Files:**
- Modify: `apps/api/package.json` (add `seed:sandbox` script)
- Create: `apps/api/src/scripts/seed_sandbox.ts`

> The seed creates emulator login users (via the Admin SDK pointed at the emulator) and the minimum Postgres rows for them to be useful: the platform tenant + a demo venue tenant. Domain inventory (venues/arenas/schedules) is intentionally left for members to create through the partner portal UI — that is the feature surface they iterate on. Model the tenant/user inserts on `apps/api/src/scripts/bootstrap_circls_tenant.ts`.

- [ ] **Step 1: Add the script entry to `apps/api/package.json`**

In the `"scripts"` block add:
```json
    "seed:sandbox": "tsx src/scripts/seed_sandbox.ts",
```

- [ ] **Step 2: Create `apps/api/src/scripts/seed_sandbox.ts`**

```ts
/**
 * Seeds the LOCAL SANDBOX only. Idempotent. Refuses to run unless the Firebase
 * Auth Emulator is configured (FIREBASE_AUTH_EMULATOR_HOST) — a guard so this
 * can never touch a real project or prod DB.
 *
 * Creates:
 *   - Auth Emulator users: an admin (custom claim admin:true), a partner phone
 *     user, a consumer phone user.
 *   - Postgres: the platform tenant (via the same shape as bootstrap) + a demo
 *     venue tenant, plus users rows linked to the emulator UIDs.
 *
 * Run:  pnpm --filter @circls/api seed:sandbox
 */
import { eq } from 'drizzle-orm';
import { getAuth } from 'firebase-admin/auth';
import { closeDb, db } from '../db/client.js';
import { env } from '../config/env.js';
import { firebaseAuth } from '../lib/firebase_admin.js';
import { tenants } from '../db/schema/tenants.js';
import { users } from '../db/schema/users.js';
import { logger } from '../lib/logger.js';

const DEMO = {
  admin: { uid: 'sandbox-admin', email: 'admin@sandbox.local', displayName: 'Sandbox Admin' },
  partner: { uid: 'sandbox-partner', phone: '+15555550101', email: 'partner@sandbox.local', displayName: 'Sandbox Partner' },
  consumer: { uid: 'sandbox-consumer', phone: '+15555550102', email: 'consumer@sandbox.local', displayName: 'Sandbox Consumer' },
};

async function ensureAuthUser(u: { uid: string; email?: string; phone?: string; displayName: string }): Promise<void> {
  const auth = firebaseAuth();
  try {
    await auth.getUser(u.uid);
    return; // already exists — idempotent
  } catch {
    /* create below */
  }
  await auth.createUser({
    uid: u.uid,
    ...(u.email ? { email: u.email, emailVerified: true } : {}),
    ...(u.phone ? { phoneNumber: u.phone } : {}),
    displayName: u.displayName,
  });
}

async function main(): Promise<void> {
  if (!env.FIREBASE_AUTH_EMULATOR_HOST) {
    process.stderr.write('Refusing to seed: FIREBASE_AUTH_EMULATOR_HOST is not set (sandbox only).\n');
    process.exit(1);
  }

  // 1. Emulator users.
  await ensureAuthUser(DEMO.admin);
  await ensureAuthUser(DEMO.partner);
  await ensureAuthUser(DEMO.consumer);
  await getAuth().setCustomUserClaims(DEMO.admin.uid, { admin: true });

  // 2. Platform tenant (idempotent — mirrors bootstrap_circls_tenant.ts).
  const slug = env.CIRCLS_INTERNAL_TENANT_SLUG;
  const [platform] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!platform) {
    await db.insert(tenants).values({ slug, name: 'Circls', isPlatform: true, status: 'active' });
  }

  // 3. Demo venue tenant.
  const demoSlug = 'demo-venue';
  const [demo] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, demoSlug)).limit(1);
  if (!demo) {
    await db.insert(tenants).values({ slug: demoSlug, name: 'Demo Venue Co', isPlatform: false, status: 'active' });
  }

  // 4. Users rows linked to the emulator UIDs (idempotent on firebaseUid).
  for (const u of [DEMO.admin, DEMO.partner, DEMO.consumer]) {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.firebaseUid, u.uid)).limit(1);
    if (!row) {
      await db.insert(users).values({ firebaseUid: u.uid, email: u.email ?? `${u.uid}@sandbox.local`, displayName: u.displayName });
    }
  }

  logger.info('sandbox_seed_complete');
  process.stdout.write(
    'Sandbox seeded.\n' +
    '  Admin login (admin console):    admin@sandbox.local  (set any password via emulator; or use email-link)\n' +
    `  Partner login (partner portal): phone ${DEMO.partner.phone} — OTP shown in the emulator UI (localhost:4000) / logs\n` +
    `  Consumer login (consumer web):  phone ${DEMO.consumer.phone} — OTP shown in the emulator UI / logs\n`,
  );
  await closeDb();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'sandbox_seed_failed');
  process.exit(1);
});
```

> Implementer note: confirm the `users` and `tenants` column names against `apps/api/src/db/schema/users.ts` and `.../tenants.ts` (the shapes used here — `firebaseUid`, `email`, `displayName`, `slug`, `name`, `isPlatform`, `status` — are taken verbatim from `bootstrap_circls_tenant.ts`). If linking the partner user to the demo tenant as an owner is desired, use the membership/role mechanism in `apps/api/src/services/invitation_service.ts` (the same one `bootstrap_circls_tenant.ts` calls) rather than a raw insert.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @circls/api typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/package.json apps/api/src/scripts/seed_sandbox.ts
git commit -m "feat(api): sandbox seed script (emulator users + demo tenants)"
```

---

## Task 10: The `./sandbox` wrapper

**Files:**
- Create: `sandbox` (executable, repo root)

- [ ] **Step 1: Create `sandbox` at repo root**

```bash
#!/usr/bin/env bash
# Circls local sandbox controller. One command to run the whole stack offline.
set -euo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f compose.sandbox.yaml"

case "${1:-help}" in
  setup)
    command -v gh >/dev/null || { echo "Install GitHub CLI (gh) first: https://cli.github.com"; exit 1; }
    gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first."; exit 1; }
    echo "→ Forking the repo (creates your own copy; you cannot push to the main repo)…"
    gh repo fork --remote --remote-name origin || true
    echo "→ Installing the PR-only git guard…"
    git config core.hooksPath .githooks
    echo "→ Building images (first time pulls deps; a few minutes)…"
    $COMPOSE build
    echo "✓ Setup done. Next: ./sandbox up"
    ;;
  up)
    shift || true
    if [ "$#" -gt 0 ]; then $COMPOSE up -d postgres firebase-emulator mailpit api "$@"; else $COMPOSE up -d; fi
    echo "→ Waiting for the API…"; sleep 3
    echo "✓ Up. Partners http://localhost:3001 · Admin http://localhost:3002 · Consumer http://localhost:3003"
    echo "  Emulator UI (OTP codes) http://localhost:4000 · Email inbox http://localhost:8025"
    echo "  Run './sandbox seed' once to create demo logins."
    ;;
  seed)
    $COMPOSE exec api pnpm --filter @circls/api seed:sandbox
    ;;
  reset)
    echo "→ Wiping the database + emulator state and reseeding…"
    $COMPOSE down -v
    $COMPOSE up -d postgres firebase-emulator mailpit
    sleep 5
    $COMPOSE up -d api partners admin consumer
    sleep 5
    $COMPOSE exec api pnpm --filter @circls/api seed:sandbox
    echo "✓ Clean, seeded state restored."
    ;;
  down) $COMPOSE down ;;
  build) $COMPOSE build ;;
  logs) shift || true; $COMPOSE logs -f "$@" ;;
  *)
    cat <<'EOF'
Circls sandbox — usage:
  ./sandbox setup        First-time: fork the repo, install the git guard, build images
  ./sandbox up [apps…]   Start everything (or a subset, e.g. ./sandbox up partners)
  ./sandbox seed         Create demo login users + tenants
  ./sandbox reset        Wipe everything and reseed (use after you break things)
  ./sandbox logs [svc]   Tail logs (e.g. ./sandbox logs firebase-emulator to see OTP codes)
  ./sandbox down         Stop everything
  ./sandbox build        Rebuild images (after dependency changes)
EOF
    ;;
esac
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x sandbox`
Expected: no output; `ls -l sandbox` shows the `x` bit.

- [ ] **Step 3: Commit**

```bash
git add sandbox
git commit -m "feat(sandbox): ./sandbox controller (setup/up/seed/reset/logs/down)"
```

---

## Task 11: Git pre-push guard

**Files:**
- Create: `.githooks/pre-push`

- [ ] **Step 1: Create `.githooks/pre-push`**

```bash
#!/usr/bin/env bash
# Blocks pushing to main/release on ANY remote, plus force-pushes and branch
# deletes. Activated by `git config core.hooksPath .githooks` (./sandbox setup).
# Open a pull request instead. This is a convenience guard; the real wall is that
# sandbox members have no write access to the canonical repo (fork model).
set -euo pipefail
protected_re='^(refs/heads/)?(main|release)$'
while read -r local_ref local_sha remote_ref remote_sha; do
  short="${remote_ref#refs/heads/}"
  if [[ "$short" =~ ^(main|release)$ ]] || [[ "$remote_ref" =~ $protected_re ]]; then
    echo "✋ Blocked: pushing to '$short' is not allowed. Open a pull request instead." >&2
    exit 1
  fi
  # Deleting a remote branch sends an all-zero local sha.
  if [[ "$local_sha" =~ ^0+$ ]]; then
    echo "✋ Blocked: deleting remote branches is not allowed from the sandbox." >&2
    exit 1
  fi
done
exit 0
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x .githooks/pre-push`

- [ ] **Step 3: Verify it blocks a main push (dry run against the hook logic)**

Run:
```bash
git config core.hooksPath .githooks
printf 'refs/heads/feature abc123 refs/heads/main 000\n' | .githooks/pre-push; echo "exit=$?"
```
Expected: prints the "Blocked: pushing to 'main'" message and `exit=1`.

- [ ] **Step 4: Verify it allows a feature-branch push**

Run:
```bash
printf 'refs/heads/feature abc123 refs/heads/feature def456\n' | .githooks/pre-push; echo "exit=$?"
```
Expected: no block, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add .githooks/pre-push
git commit -m "feat(guardrails): pre-push hook blocking main/release pushes + force/delete"
```

---

## Task 12: Claude Code deny-rules + PreToolUse git guard

**Files:**
- Create: `.claude/hooks/guard-git.sh`
- Create: `.claude/settings.json`

> If `.claude/settings.json` already exists in the repo, MERGE these keys into it rather than overwriting.

- [ ] **Step 1: Create `.claude/hooks/guard-git.sh`**

```bash
#!/usr/bin/env bash
# Claude Code PreToolUse hook. Reads the tool call as JSON on stdin; for Bash
# commands it blocks pushes to main/release, merges into them, PR merges, force
# pushes, and protected-branch deletes. Exit 2 = block (message on stderr).
set -euo pipefail
input="$(cat)"
cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p')"
[ -z "$cmd" ] && exit 0

block() { echo "✋ Sandbox guard: $1 Open a pull request from your fork instead." >&2; exit 2; }

# normalize whitespace
norm="$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')"

case "$norm" in
  *"git push"*" main"*|*"git push"*" release"*|*"git push"*":main"*|*"git push"*":release"*)
    block "pushing to main/release is not allowed." ;;
  *"git push"*"--force"*|*"git push"*"-f "*|*"git push --force-with-lease"*)
    block "force-pushing is not allowed." ;;
  *"git merge "*"main"*|*"git merge "*"release"*|*"git rebase "*"main"*|*"git rebase "*"release"*)
    block "merging/rebasing onto main/release is not allowed." ;;
  *"gh pr merge"*|*"git push"*"--delete"*|*"git push"*" :main"*|*"git push"*" :release"*)
    block "merging PRs / deleting protected branches is not allowed." ;;
esac
exit 0
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x .claude/hooks/guard-git.sh`

- [ ] **Step 3: Create `.claude/settings.json`**

```json
{
  "permissions": {
    "deny": [
      "Bash(git push:* main)",
      "Bash(git push:* release)",
      "Bash(git push --force:*)",
      "Bash(gh pr merge:*)"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": ".claude/hooks/guard-git.sh" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Verify the hook blocks and allows correctly**

Run:
```bash
echo '{"tool_input":{"command":"git push origin main"}}' | .claude/hooks/guard-git.sh; echo "exit=$?"
echo '{"tool_input":{"command":"gh pr create -t x -b y"}}' | .claude/hooks/guard-git.sh; echo "exit=$?"
```
Expected: first prints a block message with `exit=2`; second is silent with `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/guard-git.sh .claude/settings.json
git commit -m "feat(guardrails): Claude Code deny-rules + PreToolUse git guard"
```

---

## Task 13: CLAUDE.md sandbox rules + SANDBOX.md onboarding

**Files:**
- Modify: `CLAUDE.md`
- Create: `SANDBOX.md`

- [ ] **Step 1: Append a section to `CLAUDE.md`**

Add at the end of `CLAUDE.md`:

```markdown
## Sandbox & contribution rules (read first if you are a team member)

You are working in a **local sandbox**. Your only path to ship work is a pull
request from your fork. You must NEVER:

- push to `main` or `release` (a push to `release` deploys to production),
- merge a pull request (`gh pr merge`), or
- force-push or delete branches on any shared remote.

Always: create a branch → commit → push to **your fork** (`origin`) → open a PR
against the upstream repo. A maintainer reviews and merges. These rules are also
enforced by a pre-push git hook and a Claude Code guard; do not try to bypass
them (`--no-verify` is not allowed).

Run the app with `./sandbox up` (see `SANDBOX.md`). All payments, storage, SMS,
and email are simulated locally — nothing reaches real users or money.
```

- [ ] **Step 2: Create `SANDBOX.md`**

```markdown
# Circls Sandbox — run the whole app on your own machine

Everything runs locally and offline. You cannot affect production, real users,
real payments, or send real emails/SMS. Break things freely — `./sandbox reset`
puts it back.

## One-time setup
1. Install **Docker Desktop** and the **GitHub CLI** (`gh`), then `gh auth login`.
2. In the project folder, run: `./sandbox setup`
   (this forks the repo to your own GitHub account and builds the app — a few minutes).

## Daily use
- Start everything:  `./sandbox up`
- Create demo logins: `./sandbox seed`  (run once after the first `up`)
- Open:
  - Partner portal — http://localhost:3001
  - Admin console  — http://localhost:3002
  - Consumer web   — http://localhost:3003
- **Logging in:** use the demo phone numbers printed by `./sandbox seed`. The
  OTP code is shown in the **Emulator UI** at http://localhost:4000 (and in
  `./sandbox logs firebase-emulator`). No real SMS is sent.
- **Emails** the app "sends" land in the inbox at http://localhost:8025.
- Messed it up? `./sandbox reset` — wipes and reseeds to a clean state.
- Stop: `./sandbox down`

## Shipping your work
Ask Claude Code to commit your changes and **open a pull request**. You cannot
push to the main project — that is intentional. A maintainer reviews and merges.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md SANDBOX.md
git commit -m "docs(sandbox): contribution rules in CLAUDE.md + SANDBOX.md onboarding"
```

---

## Task 14: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm prod/CI is unaffected (the safety regression)**

Run:
```bash
pnpm -r typecheck
pnpm --filter @circls/api test
```
Expected: PASS. Specifically the new `firebase_admin.emulator.test.ts` proves the prod path still throws when neither emulator host nor service account is set, and `email.smtp.test.ts` proves stub remains the default.

- [ ] **Step 2: Bring the stack up from clean**

Run:
```bash
./sandbox build
./sandbox up
./sandbox seed
```
Expected: all containers start; seed prints demo logins.

- [ ] **Step 3: Smoke-test each surface**

- `curl -s http://localhost:8080/v1/health` → `{"ok":true}` (or `/v1/health/live`).
- Open http://localhost:3001, log in with the demo partner phone; the OTP shows at http://localhost:4000. Confirm you reach the dashboard.
- Create a venue/arena and take a walk-in booking; confirm it persists (reload).
- Trigger an email path (e.g. an invitation); confirm the rendered email appears at http://localhost:8025.
- Run a consumer checkout on a paid item; confirm it completes as **"reserved"** (offline stub — no real payment), not an error.

- [ ] **Step 4: Verify the guardrails**

Run (from a throwaway clone configured like a member: `origin` = a fork, no upstream write):
```bash
git config core.hooksPath .githooks
git push origin main 2>&1 | tail -2        # → blocked by pre-push hook
echo '{"tool_input":{"command":"git push origin release"}}' | .claude/hooks/guard-git.sh; echo $?   # → 2
```
Expected: the `main` push is blocked; the Claude guard exits 2. A normal `git push origin <feature-branch>` to the fork succeeds, and `gh pr create` works.

- [ ] **Step 5: Verify reset**

Run: `./sandbox reset`
Expected: stack comes back up, reseeded; previously-created demo data is gone, demo logins work again.

- [ ] **Step 6: Final commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "chore(sandbox): verification fixes" || echo "nothing to commit"
```

---

## Out of scope (deferred — do NOT build)

- Remote shared staging environment (the upgraded 8GB prod droplet makes a 2nd
  Coolify env cheap to add later if a demo/shareable-URL need arises).
- Real Razorpay test keys / test webhooks (full offline stub instead; the
  consumer checkout already degrades to a clean "reserved" state).
- A "paid"-confirmation simulator for the consumer checkout (bookings stay
  "reserved" in the sandbox — sufficient for feature iteration).
- MinIO / persistent local object storage (in-memory R2 stub instead).
- Upgrading `guard-main.yml` to auto-revert non-PR pushes (optional backstop for
  the maintainer's own account; auto-reverting a protected branch is itself
  risky — left for a separate decision).
- Extracting the three duplicated `firebase/client.ts` files into a shared
  package.
```
