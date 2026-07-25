'use client';

import { useSearchParams } from 'next/navigation';
import { type FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { useValidateQrTicket } from '@/lib/api/qr';
import type { QrScanOutcome, QrScanResult } from '@/lib/api/types';
import { useTimezone } from '@/lib/timezone_context';
import { Button, Card, Input } from '@/lib/ui';

/** What door staff should do for each outcome, colour-coded for at-a-glance calls. */
const OUTCOME_META: Record<
  QrScanOutcome,
  { title: string; detail: string; tone: 'green' | 'amber' | 'red' }
> = {
  valid: {
    title: 'Valid — let them in',
    detail: 'The scan has been counted.',
    tone: 'green',
  },
  already_used: {
    title: 'Already used',
    detail: 'This pass was spent earlier, or a capped pass has no scans left.',
    tone: 'red',
  },
  expired: {
    title: 'Expired',
    detail: 'The pass is past its validity window.',
    tone: 'red',
  },
  not_yet_valid: {
    title: 'Not yet valid',
    detail: 'The pass has not entered its validity window yet.',
    tone: 'amber',
  },
  revoked: {
    title: 'Revoked',
    detail: 'The underlying booking was cancelled.',
    tone: 'red',
  },
  not_found: {
    title: 'Not found',
    detail: 'This is not a pass for your organisation. Check the code and try again.',
    tone: 'red',
  },
};

const TONE_CLASSES: Record<'green' | 'amber' | 'red', string> = {
  green: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  amber: 'border-amber-300 bg-amber-50 text-amber-800',
  red: 'border-red-300 bg-red-50 text-red-800',
};

function fmt(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function CheckInInner() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const codeParam = useSearchParams().get('code') ?? '';
  const validate = useValidateQrTicket(tenantId);
  const { resolveTz } = useTimezone();
  const tz = resolveTz();

  const [code, setCode] = useState(codeParam);
  const [result, setResult] = useState<QrScanResult | null>(null);
  /** True when the shown result came from a peek (no scan was spent). */
  const [peeked, setPeeked] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(rawCode: string, consume: boolean) {
    const trimmed = rawCode.trim();
    if (!trimmed) return;
    setErr(null);
    try {
      const res = await validate.mutateAsync({
        code: trimmed,
        ...(consume ? {} : { consume: false }),
      });
      setResult(res);
      setPeeked(!consume);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // Auto-validate once when arriving via a scanned QR link (?code=…) — the QR
  // encodes this page's URL, so a phone-camera scan lands here pre-filled.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!codeParam || !tenantId || autoRan.current) return;
    autoRan.current = true;
    void run(codeParam, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeParam, tenantId]);

  function reset() {
    setResult(null);
    setPeeked(false);
    setErr(null);
    setCode('');
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(code, true);
  }

  if (!activeTenantId) {
    return <p className="text-sm text-slate-500">Select an organization first.</p>;
  }

  const meta = result ? OUTCOME_META[result.outcome] : null;
  const ticket = result?.ticket ?? null;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-extrabold tracking-tight text-[#17151D]">Check-in</h1>

      {!result && (
        <Card
          title="Validate a pass"
          subtitle="Scan a customer's QR with any camera to land here pre-filled, or type the code from under their QR."
        >
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Input
              label="Ticket code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. 5Gm2P9tXkQ…"
              autoFocus
              autoComplete="off"
            />
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={!code.trim() || validate.isPending}
                onClick={() => void run(code, false)}
              >
                Peek (don&apos;t consume)
              </Button>
              <Button type="submit" loading={validate.isPending} disabled={!code.trim()}>
                Check in
              </Button>
            </div>
          </form>
        </Card>
      )}

      {result && meta && (
        <Card>
          <div className="flex flex-col gap-4">
            <div
              className={[
                'rounded-[var(--radius)] border px-4 py-5 text-center',
                TONE_CLASSES[meta.tone],
              ].join(' ')}
            >
              <p className="text-2xl font-semibold">{meta.title}</p>
              <p className="mt-1 text-sm opacity-80">
                {result.outcome === 'valid' && peeked
                  ? 'Peek only — no scan was spent.'
                  : meta.detail}
              </p>
            </div>

            {ticket && (
              <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Ticket
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ticket.label ?? ticket.itemType}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Customer
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ticket.customerName ?? <span className="text-slate-400">—</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Scans
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ticket.multiUse
                      ? `${ticket.scanCount} of ${ticket.maxScans ?? 'unlimited'}`
                      : `Single-use · ${ticket.scanCount === 0 ? 'unscanned' : 'scanned'}`}
                    {ticket.lastScannedAt && (
                      <span className="text-slate-400"> · last {fmt(ticket.lastScannedAt, tz)}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-[#475569]">
                    Valid ({tz})
                  </dt>
                  <dd className="mt-1 text-sm text-slate-700">
                    {ticket.validFrom ? fmt(ticket.validFrom, tz) : 'From purchase'} →{' '}
                    {ticket.validUntil ? fmt(ticket.validUntil, tz) : 'no expiry'}
                  </dd>
                </div>
              </dl>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-[#f1f5f9] pt-4">
              {peeked && result.outcome === 'valid' && (
                <Button
                  variant="secondary"
                  loading={validate.isPending}
                  onClick={() => void run(code, true)}
                >
                  Check in (consume)
                </Button>
              )}
              <Button onClick={reset}>Scan again</Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function CheckInPage() {
  // useSearchParams needs a Suspense boundary on a statically-rendered route.
  return (
    <Suspense fallback={null}>
      <CheckInInner />
    </Suspense>
  );
}
