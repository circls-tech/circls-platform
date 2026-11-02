'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api/client';
import {
  useAdminScreenDetail,
  useDeleteScreenDraft,
  usePublishScreen,
  useRollbackScreen,
  useSaveScreenDraft,
} from '@/lib/api/queries';
import type { AdminScreenHead, SduiApp, SduiMinBuild } from '@/lib/api/types';
import { cardCls, errorText, inputCls, KEY_RE, plainBtn, primaryBtn, RESERVED_KEYS, WHEN } from '../../shared';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'https://api.circls.app';

function template(app: SduiApp, key: string): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      screen: `${app}.${key}`,
      root: { type: 'column', children: [{ type: 'text', props: { text: 'Hello from the server' } }] },
    },
    null,
    2,
  );
}

type Issue = { path: (string | number)[]; message: string };

/** The server's validation issues, when the error carried them. */
function issuesOf(err: unknown): Issue[] | null {
  if (!(err instanceof ApiError)) return null;
  const issues = (err.details as { issues?: Issue[] } | undefined)?.issues;
  return Array.isArray(issues) ? issues : null;
}

function StatusPill({ status }: { status: AdminScreenHead['status'] }) {
  const tone =
    status === 'published'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'draft'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-600';
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>{status}</span>;
}

export default function ScreenEditorPage() {
  const params = useParams<{ app: string; key: string }>();
  const app = params.app as SduiApp;
  const key = params.key;
  const valid = (app === 'consumer' || app === 'partners') && KEY_RE.test(key) && !RESERVED_KEYS.includes(key);

  const detail = useAdminScreenDetail(app, valid ? key : null);
  const save = useSaveScreenDraft(app, key);
  const publish = usePublishScreen(app, key);
  const rollback = useRollbackScreen(app, key);
  const discard = useDeleteScreenDraft(app, key);

  const [text, setText] = useState('');
  const [ios, setIos] = useState('');
  const [android, setAndroid] = useState('');
  const [note, setNote] = useState('');
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string; issues?: Issue[] } | null>(null);

  // Seed the editor once: the draft, else the published body, else a template.
  const isNew = detail.isError && detail.error instanceof ApiError && detail.error.status === 404;
  useEffect(() => {
    if (loadedFrom !== null) return;
    const source = detail.data?.draft ?? detail.data?.published ?? null;
    if (source) {
      setText(JSON.stringify(source.body, null, 2));
      setIos(source.minBuild.ios?.toString() ?? '');
      setAndroid(source.minBuild.android?.toString() ?? '');
      setNote(source.status === 'draft' ? (source.note ?? '') : '');
      setLoadedFrom(`${source.status} v${source.version}`);
    } else if (isNew) {
      setText(template(app, key));
      setLoadedFrom('template');
    }
  }, [detail.data, isNew, loadedFrom, app, key]);

  const minBuild = useMemo(() => {
    const mb: SduiMinBuild = {};
    if (ios) mb.ios = Number(ios);
    if (android) mb.android = Number(android);
    return mb;
  }, [ios, android]);

  function parseLocal(): unknown | undefined {
    try {
      const parsed: unknown = JSON.parse(text);
      setMessage(null);
      return parsed;
    } catch (e) {
      setMessage({ tone: 'err', text: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
      return undefined;
    }
  }

  function onValidate() {
    const body = parseLocal();
    if (body === undefined) return;
    // The server is the validator: a save attempt reports its issues, and a
    // valid document is a draft worth keeping anyway.
    save.mutate(
      { body, minBuild, note: note || undefined },
      {
        onSuccess: (row) => setMessage({ tone: 'ok', text: `Valid. Saved as draft v${row.version}.` }),
        onError: (e) => setMessage({ tone: 'err', text: errorText(e), issues: issuesOf(e) ?? undefined }),
      },
    );
  }

  function onSave() {
    const body = parseLocal();
    if (body === undefined) return;
    save.mutate(
      { body, minBuild, note: note || undefined },
      {
        onSuccess: (row) => setMessage({ tone: 'ok', text: `Draft v${row.version} saved.` }),
        onError: (e) => setMessage({ tone: 'err', text: errorText(e), issues: issuesOf(e) ?? undefined }),
      },
    );
  }

  function onPublish() {
    const draft = detail.data?.draft;
    if (!draft) return;
    if (!window.confirm(`Publish draft v${draft.version} of ${app}.${key}?\n\nApps pick it up within a minute. Save the draft first if you have unsaved edits.`)) return;
    publish.mutate(undefined, {
      onSuccess: (row) => {
        setMessage({ tone: 'ok', text: `Published v${row.version}.` });
        setLoadedFrom(null);
      },
      onError: (e) => setMessage({ tone: 'err', text: errorText(e) }),
    });
  }

  function onDiscard() {
    if (!window.confirm('Delete the draft? The published layout is untouched.')) return;
    discard.mutate(undefined, {
      onSuccess: () => {
        setMessage({ tone: 'ok', text: 'Draft deleted.' });
        setLoadedFrom(null);
      },
      onError: (e) => setMessage({ tone: 'err', text: errorText(e) }),
    });
  }

  function onRollback(version: number) {
    if (!window.confirm(`Roll back to v${version}?\n\nIts body is published again as a new version; history is kept.`)) return;
    rollback.mutate(version, {
      onSuccess: (row) => setMessage({ tone: 'ok', text: `Rolled back: v${version} is live again as v${row.version}.` }),
      onError: (e) => setMessage({ tone: 'err', text: errorText(e) }),
    });
  }

  if (!valid) {
    return <p className="text-sm text-red-600">Not a valid screen: app must be consumer or partners, key a-z, 0-9 and _.</p>;
  }

  const busy = save.isPending || publish.isPending || rollback.isPending || discard.isPending;
  const publicUrl = `${API_BASE}/v1/screens/${app}/${key}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">
            <Link href="/screens" className="hover:underline">Screens</Link> / {app}
          </p>
          <h1 className="font-mono text-2xl font-extrabold tracking-tight text-[#17151D]">{key}</h1>
          <p className="text-sm text-slate-500">
            {detail.data?.published ? `Published v${detail.data.published.version}` : 'Nothing published yet'}
            {detail.data?.draft ? ` · draft v${detail.data.draft.version}` : ''}
            {loadedFrom ? ` · editor loaded from ${loadedFrom}` : ''}
          </p>
        </div>
      </div>

      {detail.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {detail.isError && !isNew && <p className="text-sm text-red-600">Failed to load: {errorText(detail.error)}</p>}

      {message && (
        <div
          className={[
            'rounded-md border px-3 py-2 text-sm',
            message.tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-700',
          ].join(' ')}
        >
          {message.text}
          {message.issues && message.issues.length > 0 && (
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {message.issues.map((i, n) => (
                <li key={n}>{i.path.length ? i.path.join('.') : '(document)'}: {i.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className={cardCls}>
          <h2 className="text-sm font-semibold text-slate-900">Draft</h2>
          <textarea
            className="mt-2 h-[32rem] w-full rounded-md border border-slate-300 p-3 font-mono text-xs leading-relaxed"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <label className="text-xs text-slate-600">
              Min iOS build
              <input className={inputCls} type="number" min={0} value={ios} onChange={(e) => setIos(e.target.value)} placeholder="any" />
            </label>
            <label className="text-xs text-slate-600">
              Min Android build
              <input className={inputCls} type="number" min={0} value={android} onChange={(e) => setAndroid(e.target.value)} placeholder="any" />
            </label>
            <label className="text-xs text-slate-600">
              Note
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="What changed" />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={onValidate} disabled={busy} className={plainBtn}>Validate</button>
            <button type="button" onClick={onSave} disabled={busy} className={primaryBtn}>
              {save.isPending ? 'Saving…' : 'Save draft'}
            </button>
            <button type="button" onClick={onPublish} disabled={busy || !detail.data?.draft} className={primaryBtn}>
              {publish.isPending ? 'Publishing…' : 'Publish'}
            </button>
            {detail.data?.draft && (
              <button type="button" onClick={onDiscard} disabled={busy} className={plainBtn}>Delete draft</button>
            )}
          </div>
          <div className="mt-3 space-y-1 text-xs text-slate-500">
            <p>
              Public: <code className="rounded bg-slate-100 px-1">{publicUrl}?platform=ios&amp;build=…</code>
            </p>
            <p>
              Preview the draft on a device: the app’s debug “SDUI preview” setting points at{' '}
              <code className="rounded bg-slate-100 px-1">{publicUrl}?draft=1</code> (needs a Circls admin sign-in).
            </p>
          </div>
        </section>

        <div className="space-y-4">
          <section className={cardCls}>
            <h2 className="text-sm font-semibold text-slate-900">History</h2>
            <ul className="mt-2 divide-y divide-slate-100">
              {(detail.data?.history ?? []).map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-800">
                      v{h.version} <StatusPill status={h.status} />
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {WHEN.format(new Date(h.publishedAt ?? h.createdAt))}
                      {h.note ? ` · ${h.note}` : ''}
                      {Object.keys(h.minBuild).length
                        ? ` · min ${Object.entries(h.minBuild).map(([p, b]) => `${p} ${b}`).join(', ')}`
                        : ''}
                    </p>
                  </div>
                  {h.status !== 'draft' && h.version !== detail.data?.published?.version && (
                    <button type="button" onClick={() => onRollback(h.version)} disabled={busy} className={plainBtn}>
                      Roll back to this
                    </button>
                  )}
                </li>
              ))}
              {detail.data && detail.data.history.length === 0 && (
                <li className="py-2 text-xs text-slate-400">No versions yet.</li>
              )}
            </ul>
          </section>

          <section className={cardCls}>
            <h2 className="text-sm font-semibold text-slate-900">
              Published {detail.data?.published ? `v${detail.data.published.version}` : ''}
            </h2>
            {detail.data?.published ? (
              <pre className="mt-2 max-h-[24rem] overflow-auto rounded-md bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700">
                {JSON.stringify(detail.data.published.body, null, 2)}
              </pre>
            ) : (
              <p className="mt-2 text-xs text-slate-400">Nothing published yet.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
