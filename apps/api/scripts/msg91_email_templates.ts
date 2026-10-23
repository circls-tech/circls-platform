/**
 * Manage the designed emails' templates in MSG91.
 *
 *   pnpm --filter @circls/api email:msg91-templates list
 *       Each design's MSG91 slug and whether MSG91 has it (and its status).
 *   pnpm --filter @circls/api email:msg91-templates create
 *       Create every missing template (name, slug, subject, HTML body); MSG91
 *       then reviews them. Existing slugs are left alone — MSG91 has no update
 *       API, so edit those in the dashboard (or `export` and paste).
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
  slug?: string;
  name?: string;
  status_id?: number;
  status?: string;
}

async function existing(): Promise<Map<string, Msg91Template>> {
  const res = await fetch(`${API}?per_page=100&page=1`, {
    headers: { authkey: authKey(), accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`list failed: ${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { data?: { data?: Msg91Template[] } | Msg91Template[] };
  const list = (Array.isArray(json.data) ? json.data : json.data?.data) ?? [];
  return new Map(list.filter((t) => t.slug).map((t) => [t.slug as string, t]));
}

const STATUS: Record<number, string> = { 1: 'pending', 2: 'approved', 5: 'rejected' };

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
    const state = t ? (STATUS[t.status_id ?? 0] ?? t.status ?? 'present') : 'missing';
    process.stdout.write(`${state.padEnd(9)} ${d.msg91Slug!.padEnd(32)} ${d.key}\n`);
  }
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
  process.stdout.write('MSG91 reviews new templates; check with `list`, then switch approved ones on with MSG91_EMAIL_DESIGNS.\n');
} else {
  process.stderr.write('usage: msg91_email_templates.ts list | create | export <dir>\n');
  process.exit(2);
}
