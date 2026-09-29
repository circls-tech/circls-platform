'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api/client';
import {
  useAdminPaymentSettings,
  useClearInrFailover,
  useSetInrGateway,
} from '@/lib/api/queries';
import type { AdminPaymentSettings, InrGateway } from '@/lib/api/types';

const GATEWAY_NAME: Record<InrGateway, string> = { razorpay: 'Razorpay', cashfree: 'Cashfree' };

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function fmtWhen(iso: string): string {
  return WHEN.format(new Date(iso));
}

function minutes(sec: number): string {
  const m = Math.round(sec / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

function Pill({ tone, label }: { tone: string; label: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {label}
    </span>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your role can view payment settings but not change them.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function isLive(settings: AdminPaymentSettings, gateway: InrGateway): boolean {
  return settings.gateways[gateway].mode === 'live';
}

export default function PaymentsPage() {
  const { data, isLoading, isError, error } = useAdminPaymentSettings();
  const setGateway = useSetInrGateway();
  const clearFailover = useClearInrFailover();
  const [actionError, setActionError] = useState<string | null>(null);

  function onSwitch(to: InrGateway) {
    if (!data) return;
    const warning = isLive(data, to)
      ? ''
      : `\n\n${GATEWAY_NAME[to]} has no keys on this server, so Indian checkouts will be reserved without taking payment.`;
    const ok = window.confirm(
      `Send new Indian payments to ${GATEWAY_NAME[to]}?\n\nCheckouts already open keep their gateway, and refunds always go back through the gateway that took the payment.${warning}`,
    );
    if (!ok) return;
    setActionError(null);
    setGateway.mutate(to, { onError: (err) => setActionError(errorText(err)) });
  }

  function onRetryCashfree() {
    setActionError(null);
    clearFailover.mutate(undefined, { onError: (err) => setActionError(errorText(err)) });
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Payments</h1>
        <p className="text-sm text-slate-500">
          Which gateway takes Indian (INR) payments. US payments always go through Stripe.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {actionError}
        </div>
      )}

      {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {isError && (
        <p className="text-sm text-red-600">
          Failed to load: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      )}

      {data && (
        <>
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">New Indian payments go to</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {data.source === 'admin' && data.updatedAt
                ? `Chosen here on ${fmtWhen(data.updatedAt)}. The server’s default is ${GATEWAY_NAME[data.envDefault]}.`
                : 'Not changed here yet: this is the server’s default.'}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(['razorpay', 'cashfree'] as const).map((g) => {
                const selected = data.inrGateway === g;
                const live = isLive(data, g);
                return (
                  <div
                    key={g}
                    className={[
                      'rounded-md border p-3',
                      selected ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-200',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{GATEWAY_NAME[g]}</span>
                      <Pill
                        tone={live ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}
                        label={
                          !live
                            ? 'No keys'
                            : g === 'cashfree'
                              ? `Live · ${data.gateways.cashfree.environment}`
                              : 'Live'
                        }
                      />
                    </div>
                    {selected ? (
                      <p className="mt-2 text-xs font-medium text-slate-700">Taking new payments</p>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSwitch(g)}
                        disabled={setGateway.isPending}
                        className="mt-2 rounded-md border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                      >
                        {setGateway.isPending ? 'Switching…' : `Switch to ${GATEWAY_NAME[g]}`}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Switching affects new checkouts only. Payments already open, and all refunds, stay
              with the gateway that took them. Customers pay the same fee on either gateway.
              Checkouts from an app build that can’t open Cashfree’s checkout always go to
              Razorpay.
            </p>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Automatic failover to Razorpay</h2>
            {data.failover.active && data.failover.until ? (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Cashfree kept failing, so new Indian payments are going to Razorpay until{' '}
                {fmtWhen(data.failover.until)}.
              </div>
            ) : (
              <p className="mt-1 text-sm text-slate-700">
                {data.inrGateway === 'cashfree'
                  ? 'Not active: new Indian payments are going to Cashfree.'
                  : 'Not in use while Razorpay is selected.'}
              </p>
            )}
            <p className="mt-2 text-xs text-slate-500">
              If Cashfree can’t create an order, that checkout moves to Razorpay straight away.
              After {data.failover.threshold} Cashfree outages (timeouts or server errors) within{' '}
              {minutes(data.failover.windowSec)}, every new Indian payment goes to Razorpay for{' '}
              {minutes(data.failover.cooldownSec)}, then Cashfree is tried again. The count is kept
              in the API server’s memory, so a restart resets it.
              {data.failover.recentOutages > 0 &&
                ` Outages in the last ${minutes(data.failover.windowSec)}: ${data.failover.recentOutages}.`}
            </p>
            {data.failover.active && (
              <button
                type="button"
                onClick={onRetryCashfree}
                disabled={clearFailover.isPending}
                className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
              >
                {clearFailover.isPending ? 'Working…' : 'Try Cashfree again now'}
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
