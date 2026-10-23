/**
 * Manage the designed emails' templates in MSG91.
 *
 *   pnpm --filter @circls/api email:msg91-templates list
 *       Each design's MSG91 slug, its newest version's review status, and
 *       which version is active (the one MSG91 sends).
 *   pnpm --filter @circls/api email:msg91-templates create
 *       Create every missing template (name, subject, HTML body); MSG91 then
 *       reviews them. MSG91 derives each slug from the name (see
 *       msg91SlugFromName), which is why each design's name and msg91Slug
 *       must agree. Existing templates are left alone.
 *   pnpm --filter @circls/api email:msg91-templates update [key…]
 *       After changing a design: add its current subject + HTML as a new
 *       version of the existing template (same slug, so no code or env
 *       change). The new version is pending review and inactive; the
 *       previous one keeps sending until the new one is approved and active.
 *       With keys, only those designs; without, every design whose template
 *       exists. (POST /api/v5/email/template-versions — not in MSG91's docs,
 *       but it is what the dashboard's "new version" uses.)
 *   pnpm --filter @circls/api email:msg91-templates export <dir>
 *       Write <slug>.html + <slug>.subject.txt per template, for pasting into
 *       the dashboard's HTML (source) editor by hand.
 *
 * Needs MSG91_AUTH_KEY with Email → Templates add/edit allowed. Once a
 * template is approved, switch it on with MSG91_EMAIL_DESIGNS (see
 * docs/EMAIL_SETUP.md); until then that email goes out through the generic
 * template as plain text.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env['DATABASE_URL'] ??= 'postgres://placeholder@127.0.0.1:5432/placeholder';

const { EMAIL_DESIGNS } = await import('../src/lib/notifications/email_designs/index.js');

const API = 'https://control.msg91.com/api/v5/email/templates';

/**
 * The subject as MSG91 should store it. MSG91 renders subjects with
 * Handlebars too, where `{{x}}` HTML-escapes — "Clay & Kiln" would arrive as
 * "Clay &amp; Kiln" — so plain variables become `{{{x}}}` there. (We render
 * subjects unescaped ourselves; the HTML body keeps escaping.)
 */
export function msg91Subject(subject: string): string {
  return subject.replace(/\{\{(?![{#/!>])\s*([\w.]+)\s*\}\}/g, '{{{$1}}}');
}

const designs = EMAIL_DESIGNS.filter((d) => d.msg91Slug);

function authKey(): string {
  const key = process.env['MSG91_AUTH_KEY'];
  if (!key) {
    process.stderr.write('MSG91_AUTH_KEY is not set.\n');
    process.exit(2);
  }
  return key;
}

interface Msg91Template {
  id?: number;
  slug?: string;
  name?: string;
  /** Newest first; review status lives on the version (1 pending, 2 approved, 5 rejected). */
  versions?: Array<{ name?: string; status_id?: number; mail_type_id?: number; is_active?: boolean }>;
}

async function existing(): Promise<Map<string, Msg91Template>> {
  const res = await fetch(`${API}?per_page=100&page=1&with=versions`, {
    headers: { authkey: authKey(), accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`list failed: ${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { data?: { data?: Msg91Template[] } | Msg91Template[] };
  const list = (Array.isArray(json.data) ? json.data : json.data?.data) ?? [];
  return new Map(list.filter((t) => t.slug).map((t) => [t.slug as string, t]));
}

const STATUS: Record<number, string> = { 1: 'pending', 2: 'approved', 5: 'rejected' };
const MAIL_TYPE: Record<number, string> = { 1: 'transactional', 2: 'notification', 3: 'promotional' };

const [command = 'list', arg] = process.argv.slice(2);

if (command === 'export') {
  const dir = arg ?? 'msg91-templates';
  mkdirSync(dir, { recursive: true });
  for (const d of designs) {
    writeFileSync(join(dir, `${d.msg91Slug}.html`), d.html);
    writeFileSync(join(dir, `${d.msg91Slug}.subject.txt`), `${msg91Subject(d.subject)}\n`);
    process.stdout.write(`${d.msg91Slug}  ←  ${d.key}\n`);
  }
  process.stdout.write(`Wrote ${designs.length} templates to ${dir}\n`);
} else if (command === 'list') {
  const have = await existing();
  for (const d of designs) {
    const t = have.get(d.msg91Slug!);
    const v = t?.versions?.[0];
    const state = t ? `${v?.name ?? '?'} ${STATUS[v?.status_id ?? 0] ?? 'present'}` : 'missing';
    const active = t?.versions?.find((x) => x.is_active)?.name ?? (t ? 'none' : '');
    // MSG91 decides the mail type itself; transactional is what these are.
    const type = v?.mail_type_id ? (MAIL_TYPE[v.mail_type_id] ?? String(v.mail_type_id)) : '';
    process.stdout.write(
      `${state.padEnd(14)} active:${active.padEnd(6)} ${type.padEnd(14)} ${d.msg91Slug!.padEnd(36)} ${d.key}\n`,
    );
  }
} else if (command === 'update') {
  const only = process.argv.slice(3);
  const have = await existing();
  for (const d of designs.filter((x) => only.length === 0 || only.includes(x.key))) {
    const t = have.get(d.msg91Slug!);
    if (!t?.id) {
      process.stdout.write(`missing  ${d.msg91Slug} — run \`create\` first\n`);
      continue;
    }
    const res = await fetch('https://control.msg91.com/api/v5/email/template-versions', {
      method: 'POST',
      headers: { authkey: authKey(), accept: 'application/json', 'content-type': 'application/json' },
      // A version may not carry a name: MSG91 numbers it (v1.1, v1.2, …).
      body: JSON.stringify({ template_id: t.id, subject: msg91Subject(d.subject), body: d.html }),
    });
    const text = await res.text();
    let version = '';
    let hasError = !res.ok;
    try {
      const j = JSON.parse(text) as { hasError?: boolean; data?: { name?: string } };
      hasError ||= Boolean(j.hasError);
      version = j.data?.name ?? '';
    } catch {
      // non-JSON: rely on the status code
    }
    process.stdout.write(
      hasError ? `FAILED   ${d.msg91Slug}  ${text.slice(0, 300)}\n` : `updated  ${d.msg91Slug} → ${version} (pending review)\n`,
    );
  }
  process.stdout.write('The previous version keeps sending until the new one is approved and active; check with `list`.\n');
} else if (command === 'create') {
  const have = await existing();
  for (const d of designs) {
    if (have.has(d.msg91Slug!)) {
      process.stdout.write(`exists   ${d.msg91Slug}\n`);
      continue;
    }
    const res = await fetch(API, {
      method: 'POST',
      headers: { authkey: authKey(), accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ name: d.name, slug: d.msg91Slug, subject: msg91Subject(d.subject), body: d.html }),
    });
    const text = await res.text();
    let hasError = !res.ok;
    try {
      hasError ||= Boolean((JSON.parse(text) as { hasError?: boolean }).hasError);
    } catch {
      // non-JSON: rely on the status code
    }
    process.stdout.write(`${hasError ? 'FAILED ' : 'created'}  ${d.msg91Slug}${hasError ? `  ${text.slice(0, 300)}` : ''}\n`);
  }
  // MSG91 derives the slug from the name rather than taking ours; check it
  // came out as the slug the app sends.
  const after = await existing();
  for (const d of designs) {
    if (!after.has(d.msg91Slug!)) {
      process.stdout.write(`WARNING  no template with slug ${d.msg91Slug} — map the one MSG91 made with MSG91_EMAIL_TEMPLATES=${d.key}=<its slug>\n`);
    }
  }
  process.stdout.write('MSG91 reviews new templates; check with `list`, then switch approved ones on with MSG91_EMAIL_DESIGNS.\n');
} else {
  process.stderr.write('usage: msg91_email_templates.ts list | create | update [key…] | export <dir>\n');
  process.exit(2);
}
