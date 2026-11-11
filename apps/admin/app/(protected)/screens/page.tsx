'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  useAdminScreens,
  useSduiFlags,
  useSduiUpdateNotice,
  useSetSduiFlags,
  useSetSduiUpdateNotice,
} from '@/lib/api/queries';
import type { SduiApp, SduiFlags, SduiUpdateNotice } from '@/lib/api/types';
import { cardCls, errorText, inputCls, KEY_RE, plainBtn, primaryBtn, RESERVED_KEYS, WHEN } from './shared';

const APPS: { id: SduiApp; label: string }[] = [
  { id: 'consumer', label: 'Consumer' },
  { id: 'partners', label: 'Partners' },
];
function AppSwitcher({ app, onChange }: { app: SduiApp; onChange: (a: SduiApp) => void }) {
  return (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm">
      {APPS.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onChange(a.id)}
          className={[
            'rounded px-3 py-1 font-medium',
            app === a.id ? 'bg-[#17151D] text-white' : 'text-slate-600 hover:bg-slate-100',
          ].join(' ')}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

function ScreensTable({ app }: { app: SduiApp }) {
  const { data, isLoading, isError, error } = useAdminScreens(app);
  const [newKey, setNewKey] = useState('');
  const keyOk = KEY_RE.test(newKey) && !RESERVED_KEYS.includes(newKey);
  return (
    <section className={cardCls}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Screens</h2>
          <p className="text-xs text-slate-500">
            One row per screen key. The highest published version an app build may render is what it gets.
          </p>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (keyOk) window.location.assign(`/screens/${app}/${newKey}`);
          }}
        >
          <label className="text-xs text-slate-600">
            New screen key
            <input
              className={inputCls}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.trim())}
              placeholder="explore"
            />
          </label>
          <button type="submit" disabled={!keyOk} className={primaryBtn}>
            Open editor
          </button>
        </form>
      </div>
      {isLoading && <p className="mt-3 text-sm text-slate-400">Loading…</p>}
      {isError && <p className="mt-3 text-sm text-red-600">Failed to load: {errorText(error)}</p>}
      {data && (
        <table className="mt-3 w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Key</th>
              <th className="px-3 py-2 text-right font-medium">Published</th>
              <th className="px-3 py-2 text-right font-medium">Draft</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.screens.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-xs text-slate-400">
                  No screens yet. Type a key above to start one.
                </td>
              </tr>
            )}
            {data.screens.map((s) => (
              <tr key={s.key}>
                <td className="px-3 py-2 font-mono text-xs text-slate-800">{s.key}</td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-700">
                  {s.publishedVersion === null ? '—' : `v${s.publishedVersion}`}
                </td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-700">
                  {s.draftVersion === null ? '—' : `v${s.draftVersion}`}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{WHEN.format(new Date(s.updatedAt))}</td>
                <td className="px-3 py-2 text-right">
                  <Link href={`/screens/${app}/${s.key}`} className="text-xs font-medium text-brand-700 hover:underline">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function FlagsCard({ app }: { app: SduiApp }) {
  const { data, isLoading, isError, error } = useSduiFlags(app);
  const save = useSetSduiFlags(app);
  const [newFlag, setNewFlag] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const flags: SduiFlags = data?.flags ?? {};
  const flagOk = /^[A-Za-z0-9_.-]{1,64}$/.test(newFlag) && !(newFlag in flags);

  function commit(next: SduiFlags) {
    setErr(null);
    save.mutate(next, { onError: (e) => setErr(errorText(e)) });
  }

  return (
    <section className={cardCls}>
      <h2 className="text-sm font-semibold text-slate-900">Flags</h2>
      <p className="text-xs text-slate-500">
        Served in the manifest; a node’s <code>visible: {'{'}flag{'}'}</code> condition reads them. Changes reach
        the apps within a minute.
      </p>
      {err && <p className="mt-2 text-xs text-rose-700">{err}</p>}
      {isLoading && <p className="mt-3 text-sm text-slate-400">Loading…</p>}
      {isError && <p className="mt-3 text-sm text-red-600">Failed to load: {errorText(error)}</p>}
      {data && (
        <ul className="mt-3 divide-y divide-slate-100">
          {Object.keys(flags).length === 0 && <li className="py-2 text-xs text-slate-400">No flags yet.</li>}
          {Object.entries(flags)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, on]) => (
              <li key={name} className="flex items-center justify-between gap-2 py-2">
                <span className="font-mono text-xs text-slate-800">{name}</span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    disabled={save.isPending}
                    onClick={() => commit({ ...flags, [name]: !on })}
                    className={[
                      'relative h-5 w-9 rounded-full border border-slate-300 transition-colors',
                      on ? 'bg-emerald-500' : 'bg-slate-200',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
                        on ? 'translate-x-4' : 'translate-x-0.5',
                      ].join(' ')}
                    />
                  </button>
                  <button
                    type="button"
                    disabled={save.isPending}
                    onClick={() => {
                      const { [name]: _gone, ...rest } = flags;
                      commit(rest);
                    }}
                    className="text-xs text-slate-400 hover:text-rose-600"
                    aria-label={`Remove ${name}`}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
        </ul>
      )}
      <form
        className="mt-3 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!flagOk) return;
          commit({ ...flags, [newFlag]: false });
          setNewFlag('');
        }}
      >
        <label className="flex-1 text-xs text-slate-600">
          Add flag
          <input
            className={inputCls}
            value={newFlag}
            onChange={(e) => setNewFlag(e.target.value.trim())}
            placeholder="explore.hero_banner"
          />
        </label>
        <button type="submit" disabled={!flagOk || save.isPending} className={plainBtn}>
          Add (off)
        </button>
      </form>
    </section>
  );
}

function UpdateNoticeCard({ app }: { app: SduiApp }) {
  const { data, isLoading, isError, error } = useSduiUpdateNotice(app);
  const save = useSetSduiUpdateNotice(app);
  const [ios, setIos] = useState('');
  const [android, setAndroid] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const u = data?.update;
    setIos(u?.minSupportedBuild.ios?.toString() ?? '');
    setAndroid(u?.minSupportedBuild.android?.toString() ?? '');
    setTitle(u?.message.title ?? '');
    setBody(u?.message.body ?? '');
    setUrl(u?.message.url ?? '');
  }, [data]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const minSupportedBuild: SduiUpdateNotice['minSupportedBuild'] = {};
    if (ios) minSupportedBuild.ios = Number(ios);
    if (android) minSupportedBuild.android = Number(android);
    setErr(null);
    save.mutate({ minSupportedBuild, message: { title, body, url } }, { onError: (e) => setErr(errorText(e)) });
  }

  function clear() {
    if (!window.confirm('Clear the update notice? Apps stop showing it within a minute.')) return;
    setErr(null);
    save.mutate(null, { onError: (e) => setErr(errorText(e)) });
  }

  return (
    <section className={cardCls}>
      <h2 className="text-sm font-semibold text-slate-900">Update notice</h2>
      <p className="text-xs text-slate-500">
        Builds below the minimum supported build are asked to update (the app decides soft vs. forced). Leave
        a platform blank to not gate it.
      </p>
      {err && <p className="mt-2 text-xs text-rose-700">{err}</p>}
      {isLoading && <p className="mt-3 text-sm text-slate-400">Loading…</p>}
      {isError && <p className="mt-3 text-sm text-red-600">Failed to load: {errorText(error)}</p>}
      {data && (
        <form className="mt-3 space-y-2" onSubmit={submit}>
          <p className="text-xs font-medium text-slate-700">
            {data.update ? 'A notice is live.' : 'No notice is set.'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              Min iOS build
              <input className={inputCls} type="number" min={0} value={ios} onChange={(e) => setIos(e.target.value)} />
            </label>
            <label className="text-xs text-slate-600">
              Min Android build
              <input className={inputCls} type="number" min={0} value={android} onChange={(e) => setAndroid(e.target.value)} />
            </label>
          </div>
          <label className="block text-xs text-slate-600">
            Title
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </label>
          <label className="block text-xs text-slate-600">
            Body
            <textarea className={inputCls} rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
          </label>
          <label className="block text-xs text-slate-600">
            Store URL
            <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" maxLength={2000} />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={save.isPending || !title} className={primaryBtn}>
              {save.isPending ? 'Saving…' : 'Save notice'}
            </button>
            {data.update && (
              <button type="button" onClick={clear} disabled={save.isPending} className={plainBtn}>
                Clear
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

export default function ScreensPage() {
  const [app, setApp] = useState<SduiApp>('consumer');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-[#17151D]">Screens</h1>
          <p className="text-sm text-slate-500">
            Server-driven layouts, flags and the update notice for the mobile apps. Published changes ship
            without an app-store review.
          </p>
        </div>
        <AppSwitcher app={app} onChange={setApp} />
      </div>
      <ScreensTable app={app} />
      <div className="grid gap-4 lg:grid-cols-2">
        <FlagsCard app={app} />
        <UpdateNoticeCard app={app} />
      </div>
    </div>
  );
}
