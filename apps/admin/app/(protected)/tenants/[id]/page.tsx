'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { AuditLog } from '@/components/audit/AuditLog';
import {
  useAdminTenantDetail,
  useAdminTenantEvents,
  useReactivateTenant,
  useSetTenantCatalogHidden,
  useSuspendTenant,
  useUpdateEventBilling,
  useUpdateTenantBilling,
} from '@/lib/api/queries';
import type {
  AdminTenantDetail,
  AdminTenantEventBillingItem,
  CommissionWaiver,
} from '@/lib/api/types';
import { PARTNER_ROLE_INFO, ROLE_LABELS, formatRole, type TenantRole } from '@/lib/roles';
import {
  addMonths,
  daysBetween,
  fmtDay,
  previewWaiver,
  waiverSummary,
} from '@/lib/commission_waiver';
import { EventsTab, MembershipsTab, ShelfTabs, VenuesTab } from './listings_tabs';
import { EarningsTab } from './earnings_tab';
import { useAdminTenantVenues } from '@/lib/api/queries';

const IST_FMT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function fmtIST(iso: string | null | undefined): string {
  if (!iso) return '—';
  return IST_FMT.format(new Date(iso));
}

type Tab =
  | 'overview'
  | 'members'
  | 'venues'
  | 'events'
  | 'memberships'
  | 'earnings'
  | 'billing'
  | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'members', label: 'Members' },
  { id: 'venues', label: 'Venues' },
  { id: 'events', label: 'Events' },
  { id: 'memberships', label: 'Memberships' },
  // Net — what the partner is owed. Sits before Billing, which is the gross
  // and commission side of the same money.
  { id: 'earnings', label: 'Earnings' },
  { id: 'billing', label: 'Billing' },
  { id: 'audit', label: 'Audit timeline' },
];

/**
 * Which zone to cut this organisation's days in.
 *
 * Taken from the organisation's own venues, which carry a real IANA
 * `tz_name` — the first one, since this is an org-wide figure and an
 * organisation running venues in several zones has no single right answer.
 * Mapping from the registered country instead would need a new special case
 * per market, and would silently cut days in the wrong zone for any market
 * not yet listed.
 *
 * The partner's own page resolves this to the VIEWER's chosen zone instead, so
 * the two can still disagree by a day on a late-evening sale. Both state the
 * zone they used.
 */
function tenantTz(venueTz: string | null | undefined): string {
  return venueTz ?? 'Asia/Kolkata';
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'active'
      ? 'bg-emerald-100 text-emerald-800'
      : status === 'suspended'
        ? 'bg-rose-100 text-rose-800'
        : 'bg-slate-100 text-slate-700';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}

export default function TenantDetailPage() {
  const params = useParams<{ id: string }>();
  const tenantId = params.id;
  const [tab, setTab] = useState<Tab>('overview');

  const { data, isLoading, isError, error } = useAdminTenantDetail(tenantId);
  const suspend = useSuspendTenant();
  const reactivate = useReactivateTenant();
  const catalog = useSetTenantCatalogHidden();

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="space-y-3">
        <Link href="/tenants" className="text-sm text-slate-500 hover:text-slate-800">
          &larr; Tenants
        </Link>
        <p className="text-sm text-red-600">
          Failed to load tenant: {error instanceof Error ? error.message : 'unknown error'}
        </p>
      </div>
    );
  }

  const t = data.tenant;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tenants" className="text-sm text-slate-500 hover:text-slate-800">
          &larr; Tenants
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-extrabold tracking-tight text-[#17151D]">{t.name}</h1>
          <span className="font-mono text-xs text-slate-500">{t.slug}</span>
          <StatusPill status={t.status} />
          {t.hiddenFromCatalog ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              Hidden from consumers
            </span>
          ) : null}
          <WaiverPill data={data} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {t.status === 'active' ? (
          <button
            type="button"
            onClick={() => {
              if (!confirm(`Suspend "${t.name}"?`)) return;
              suspend.mutate(t.id);
            }}
            disabled={suspend.isPending}
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
          >
            {suspend.isPending ? 'Suspending…' : 'Suspend tenant'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!confirm(`Reactivate "${t.name}"?`)) return;
              reactivate.mutate(t.id);
            }}
            disabled={reactivate.isPending}
            className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
          >
            {reactivate.isPending ? 'Reactivating…' : 'Reactivate tenant'}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            const hide = !t.hiddenFromCatalog;
            const question = hide
              ? `Hide "${t.name}" from consumers? Its venues, events, memberships and profile disappear from circls.app and the app; the org keeps working for its members.`
              : `Show "${t.name}" to consumers again?`;
            if (!confirm(question)) return;
            catalog.mutate({ id: t.id, hidden: hide });
          }}
          disabled={catalog.isPending}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {catalog.isPending
            ? 'Saving…'
            : t.hiddenFromCatalog
              ? 'Show to consumers'
              : 'Hide from consumers'}
        </button>
        <Link
          href={`/tenants/${t.id}/audit`}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Full audit timeline
        </Link>
      </div>

      {/* Tabs */}
      <div className="overflow-x-auto border-b border-slate-200">
        <nav className="flex gap-6">
          {TABS.map((tt) => (
            <button
              key={tt.id}
              onClick={() => setTab(tt.id)}
              className={[
                'shrink-0 whitespace-nowrap border-b-2 px-1 pb-2 pt-1 text-sm font-medium transition-colors',
                tab === tt.id
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800',
              ].join(' ')}
              type="button"
            >
              {tt.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'overview' && <OverviewTab data={data} />}
      {tab === 'members' && <MembersTab data={data} />}
      {tab === 'venues' && <VenuesTab tenantId={t.id} />}
      {tab === 'events' && <EventsTab tenantId={t.id} />}
      {tab === 'memberships' && <MembershipsTab tenantId={t.id} />}
      {tab === 'earnings' && <EarningsTabForTenant tenantId={t.id} />}
      {tab === 'billing' && <BillingTab data={data} />}
      {tab === 'audit' && <AuditLog tenantId={t.id} />}
    </div>
  );
}

function OverviewTab({ data }: { data: AdminTenantDetail }) {
  const t = data.tenant;
  const owner = data.members.find((m) => m.role === 'owner') ?? data.members[0];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Business">
        <Field label="Legal entity" value={t.legalEntityName} />
        <Field label="GSTIN" value={t.gstin} mono />
        <Field label="PAN" value={t.panNumber} mono />
        <Field label="Subscription" value={t.subscriptionStatus} />
        <Field label="Created" value={fmtIST(t.createdAt)} />
        <Field label="Payment gateway" value={gatewayLabel(t.country)} />
      </Card>

      <Card title="Owner contact">
        {owner ? (
          <>
            <Field label="Name" value={owner.displayName} />
            <Field label="Email" value={owner.email} />
            <Field label="Phone" value={owner.phoneE164} mono />
            <Field label="Role" value={formatRole(owner.role)} />
          </>
        ) : (
          <p className="text-sm text-slate-400">No owner on record.</p>
        )}
      </Card>

      <Card title="Banking">
        <Field label="Account holder" value={t.bankAccountHolderName} />
        <Field label="Account number" value={t.bankAccountNumber} mono />
        <Field label="IFSC" value={t.bankIfsc} mono />
      </Card>
    </div>
  );
}

function RoleLegend() {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2">
      {(Object.keys(ROLE_LABELS) as TenantRole[]).map((r) => (
        <div key={r} className="text-sm">
          <dt className="inline font-medium text-slate-800">{ROLE_LABELS[r]}</dt>
          <dd className="inline text-slate-500"> — {PARTNER_ROLE_INFO[r]}</dd>
        </div>
      ))}
    </dl>
  );
}

function MembersTab({ data }: { data: AdminTenantDetail }) {
  if (data.members.length === 0) {
    return <p className="text-sm text-slate-400">No members on this tenant.</p>;
  }
  return (
    <div className="space-y-4">
    <div className="overflow-x-auto rounded-lg border-2 border-[#17151D] bg-white shadow-[4px_4px_0_#17151D]">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b-2 border-[#17151D] bg-[#FAF3E8] text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Email</th>
            <th className="px-4 py-2 font-medium">Phone</th>
            <th className="px-4 py-2 font-medium">Role</th>
            <th className="px-4 py-2 font-medium">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.members.map((m) => (
            <tr key={m.userId}>
              <td className="px-4 py-2.5 text-slate-800">
                {m.displayName ?? <span className="text-slate-400">—</span>}
              </td>
              <td className="px-4 py-2.5 text-slate-700">{m.email ?? '—'}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{m.phoneE164 ?? '—'}</td>
              <td className="px-4 py-2.5 text-slate-700">
                <span title={PARTNER_ROLE_INFO[m.role]}>{ROLE_LABELS[m.role]}</span>
              </td>
              <td className="px-4 py-2.5 text-xs text-slate-500">{fmtIST(m.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <RoleLegend />
    </div>
  );
}

// ── Billing tab ───────────────────────────────────────────────────────────────

/** '2.5' ⇄ 250 bps. Empty string = no value (inherit, for event overrides). */
function bpsToPct(bps: number | null): string {
  return bps === null ? '' : String(bps / 100);
}
function pctToBps(pct: string): number | null {
  const trimmed = pct.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function PctInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={0}
        max={100}
        step={0.05}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="w-20 rounded-md border border-slate-200 px-2 py-1 text-right text-sm text-slate-800 placeholder:text-slate-300 focus:border-slate-400 focus:outline-none"
      />
      <span className="text-xs text-slate-400">%</span>
    </span>
  );
}

/** Header pill: where the org is in its commission-free period. */
function WaiverPill({ data }: { data: AdminTenantDetail }) {
  const summary = waiverSummary(data.commissionWaiver);
  if (!summary) return null;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${summary.tone}`}
      title="Commission-free period"
    >
      Commission: {summary.label}
    </span>
  );
}

function BillingTab({ data }: { data: AdminTenantDetail }) {
  const t = data.tenant;
  const update = useUpdateTenantBilling();
  const [commission, setCommission] = useState(bpsToPct(t.commissionBps));
  const [consumerCommission, setConsumerCommission] = useState(bpsToPct(t.consumerCommissionBps));
  const [customerShare, setCustomerShare] = useState(bpsToPct(t.customerFeeShareBps));
  const [orgShare, setOrgShare] = useState(bpsToPct(t.orgFeeShareBps));
  const [advance, setAdvance] = useState(bpsToPct(t.advancePayoutBps));
  const savedStart = t.commissionWaiverStartsOn ?? '';
  const savedEnd = t.commissionWaiverEndsOn ?? '';
  const [waiverStart, setWaiverStart] = useState<DateField>({ value: savedStart, bad: false });
  const [waiverEnd, setWaiverEnd] = useState<DateField>({ value: savedEnd, bad: false });
  const [afterWaiver, setAfterWaiver] = useState(bpsToPct(t.commissionAfterWaiverBps));

  const customerBps = pctToBps(customerShare) ?? 0;
  const orgBps = pctToBps(orgShare) ?? 0;
  const platformSharePct = (10_000 - customerBps - orgBps) / 100;
  const splitInvalid = customerBps + orgBps > 10_000;
  const preview = data.commissionWaiver
    ? previewWaiver(data.commissionWaiver, waiverStart.value, waiverEnd.value)
    : null;
  // The same check the API makes: the end against the start the period will
  // actually have, set or derived from the first paid booking.
  const waiverInvalid =
    waiverStart.bad || waiverEnd.bad
      ? 'Finish typing the date, or click Use default.'
      : preview?.startsOn && waiverEnd.value !== '' && waiverEnd.value < preview.startsOn
        ? `The end date is before the start (${fmtDay(preview.startsOn)}).`
        : null;

  const save = () => {
    update.mutate({
      id: t.id,
      patch: {
        commissionBps: pctToBps(commission) ?? 0,
        consumerCommissionBps: pctToBps(consumerCommission) ?? 0,
        customerFeeShareBps: customerBps,
        orgFeeShareBps: orgBps,
        advancePayoutBps: pctToBps(advance) ?? 0,
        // Dates only when edited, so saving a rate never rewrites them.
        ...(waiverStart.value !== savedStart
          ? { commissionWaiverStartsOn: waiverStart.value || null }
          : {}),
        ...(waiverEnd.value !== savedEnd ? { commissionWaiverEndsOn: waiverEnd.value || null } : {}),
        commissionAfterWaiverBps: pctToBps(afterWaiver),
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Commission">
          <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5">
            <dt className="text-xs text-slate-500">
              Partner commission
              <span className="block text-[11px] text-slate-400">Deducted from weekly payouts</span>
            </dt>
            <dd>
              <PctInput value={commission} onChange={setCommission} label="Partner commission %" />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-slate-500">
              Consumer commission
              <span className="block text-[11px] text-slate-400">
                Charged to customers inside “Other charges”
              </span>
            </dt>
            <dd>
              <PctInput
                value={consumerCommission}
                onChange={setConsumerCommission}
                label="Consumer commission %"
              />
            </dd>
          </div>
        </Card>

        <Card title="Gateway fee split & advances">
          <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5">
            <dt className="text-xs text-slate-500">
              Customer pays
              <span className="block text-[11px] text-slate-400">
                Below 100%, checkout shows the fee struck through (FREE at 0%)
              </span>
            </dt>
            <dd>
              <PctInput value={customerShare} onChange={setCustomerShare} label="Customer fee share %" />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5">
            <dt className="text-xs text-slate-500">
              Org pays
              <span className="block text-[11px] text-slate-400">Deducted from settle base</span>
            </dt>
            <dd>
              <PctInput value={orgShare} onChange={setOrgShare} label="Org fee share %" />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5">
            <dt className="text-xs text-slate-500">Circls absorbs</dt>
            <dd className={`text-sm ${splitInvalid ? 'text-rose-600' : 'text-slate-800'}`}>
              {splitInvalid ? 'Split exceeds 100%' : `${platformSharePct}% of the gateway fee`}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-slate-500">
              Advance payout
              <span className="block text-[11px] text-slate-400">
                Share of net paid the week after capture, recouped at settlement
              </span>
            </dt>
            <dd>
              <PctInput value={advance} onChange={setAdvance} label="Advance payout %" />
            </dd>
          </div>
        </Card>
      </div>

      {preview && (
        <WaiverCard
          preview={preview}
          commissionBps={pctToBps(commission) ?? 0}
          eventsChargingCommission={data.eventsChargingCommission ?? 0}
          start={waiverStart}
          onStart={setWaiverStart}
          end={waiverEnd}
          onEnd={setWaiverEnd}
          after={afterWaiver}
          onAfter={setAfterWaiver}
          invalid={waiverInvalid}
        />
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={update.isPending || splitInvalid || waiverInvalid !== null}
          className="rounded-md border-2 border-[#17151D] bg-brand-600 px-4 py-1.5 text-sm font-medium text-slate-900 shadow-[2px_2px_0_#17151D] hover:bg-brand-700 disabled:opacity-50"
        >
          {update.isPending ? 'Saving…' : 'Save billing settings'}
        </button>
        {update.isSuccess && !update.isPending && (
          <span className="text-sm text-emerald-700">Saved.</span>
        )}
        {update.isError && (
          <span className="text-sm text-rose-600">
            {update.error instanceof Error ? update.error.message : 'Save failed'}
          </span>
        )}
      </div>

      <EventOverridesTable tenant={t} />
    </div>
  );
}

/** A YYYY-MM-DD value plus whether the field holds a date the browser can't
 *  read yet (half typed): its value is then '' and must not count as cleared. */
interface DateField {
  value: string;
  bad: boolean;
}

function DateInput({
  field,
  onChange,
  label,
}: {
  field: DateField;
  onChange: (f: DateField) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <input
        ref={ref}
        type="date"
        value={field.value}
        onChange={(e) => onChange({ value: e.target.value, bad: e.target.validity.badInput })}
        aria-label={label}
        className="rounded-md border border-slate-200 px-2 py-1 text-sm text-slate-800 focus:border-slate-400 focus:outline-none"
      />
      {(field.value !== '' || field.bad) && (
        <button
          type="button"
          onClick={() => {
            // A half-typed date already reads as '', so React would leave the
            // partial text on screen; clear the element itself.
            if (ref.current) ref.current.value = '';
            onChange({ value: '', bad: false });
          }}
          className="whitespace-nowrap text-xs text-slate-500 underline hover:text-slate-800"
        >
          Use default
        </button>
      )}
    </span>
  );
}

/**
 * The commission-free period every org was promised: its first months from
 * its first paid booking. RECORD-ONLY — the dates don't change what a sale is
 * charged; Partner commission above and the event overrides below do. Hence
 * the nudges: commission charged during the period, and a period that ended
 * with the agreed rate not applied. Everything here reads the period as the
 * edited dates will make it (previewWaiver), not as it was last saved.
 */
function WaiverCard({
  preview,
  commissionBps,
  eventsChargingCommission,
  start,
  onStart,
  end,
  onEnd,
  after,
  onAfter,
  invalid,
}: {
  preview: CommissionWaiver;
  commissionBps: number;
  eventsChargingCommission: number;
  start: DateField;
  onStart: (f: DateField) => void;
  end: DateField;
  onEnd: (f: DateField) => void;
  after: string;
  onAfter: (v: string) => void;
  invalid: string | null;
}) {
  const summary = waiverSummary(preview);
  const afterBps = pctToBps(after);
  const daysLeft =
    preview.status === 'active' && preview.endsOn ? daysBetween(preview.today, preview.endsOn) : null;
  const charging = preview.status === 'active' && (commissionBps > 0 || eventsChargingCommission > 0);

  return (
    <section className="rounded-lg border-2 border-[#17151D] bg-white p-4 shadow-[4px_4px_0_#17151D]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Commission-free period
        </h2>
        {summary && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${summary.tone}`}>
            {summary.label}
          </span>
        )}
        {daysLeft !== null && (
          <span className="text-xs text-slate-500">
            {daysLeft} day{daysLeft === 1 ? '' : 's'} left
          </span>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm lg:grid-cols-3">
        <div>
          <dt className="text-xs text-slate-500">Starts on</dt>
          <dd className="mt-1">
            <DateInput field={start} onChange={onStart} label="Commission-free period starts on" />
          </dd>
          <p className="mt-1 text-[11px] text-slate-400">
            Default: first paid booking ({preview.firstPaidOn ? fmtDay(preview.firstPaidOn) : 'none yet'})
          </p>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Ends on (commission starts)</dt>
          <dd className="mt-1">
            <DateInput field={end} onChange={onEnd} label="Commission-free period ends on" />
          </dd>
          <p className="mt-1 text-[11px] text-slate-400">
            Default: {preview.months} months after the start
            {preview.startsOn ? ` (${fmtDay(addMonths(preview.startsOn, preview.months))})` : ''}
          </p>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Commission after the period</dt>
          <dd className="mt-1">
            <PctInput value={after} onChange={onAfter} placeholder="—" label="Commission after the period %" />
          </dd>
          <p className="mt-1 text-[11px] text-slate-400">
            Shown to the partner on Earnings. Blank = not decided.
          </p>
        </div>
      </dl>
      {invalid && <p className="mt-3 text-sm text-rose-600">{invalid}</p>}
      {charging && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {commissionBps > 0 &&
            `Partner commission is ${commissionBps / 100}%, so this org’s sales are charged commission during its commission-free period. `}
          {eventsChargingCommission > 0 &&
            `${eventsChargingCommission} in-flight event${eventsChargingCommission === 1 ? ' overrides' : 's override'} partner commission above 0%, so ${eventsChargingCommission === 1 ? 'its' : 'their'} sales are charged commission${commissionBps > 0 ? ' too' : ''}. `}
          These dates don&rsquo;t stop it: set{' '}
          {commissionBps > 0 && eventsChargingCommission > 0
            ? 'Partner commission and the event overrides below'
            : commissionBps > 0
              ? 'Partner commission'
              : 'the event overrides below'}{' '}
          to 0% until {fmtDay(preview.endsOn)}.
        </p>
      )}
      {preview.status === 'ended' && afterBps !== null && afterBps !== commissionBps && (
        <p className="mt-3 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-800">
          The period ended on {fmtDay(preview.endsOn)}. Partner commission is still{' '}
          {commissionBps / 100}%; the agreed rate after the period is {afterBps / 100}%.
        </p>
      )}
    </section>
  );
}

const BILLING_EVENT_SCOPES: { key: 'active' | 'all'; label: string }[] = [
  { key: 'active', label: 'In flight' },
  { key: 'all', label: 'All' },
];

function EventOverridesTable({ tenant }: { tenant: AdminTenantDetail['tenant'] }) {
  // In flight by default — an org's finished and cancelled events pile up fast
  // and bury what it currently has running. Not called "Active" here: the
  // Events tab's Active shelf is the partner's wider "not archived" list.
  const [scope, setScope] = useState<'active' | 'all'>('active');
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
    useAdminTenantEvents(tenant.id, scope);
  const rows: AdminTenantEventBillingItem[] = data?.pages.flatMap((p) => p.rows) ?? [];

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Events
        </h2>
        <ShelfTabs
          value={scope}
          onChange={setScope}
          options={BILLING_EVENT_SCOPES}
          label="Which events to show"
        />
      </div>
      <p className="text-xs text-slate-400">
        {scope === 'active'
          ? 'Draft, awaiting review and live events, excluding anything archived. Switch to All for cancelled, rejected, ended and archived ones.'
          : 'Every event this organisation has ever created.'}
        {' '}Commission columns: blank = inherit the tenant rate (shown greyed), 0 = explicitly disabled.
      </p>
      {isLoading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">
          {scope === 'active'
            ? 'Nothing in flight. Switch to All to see finished events.'
            : 'This tenant has no events.'}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border-2 border-[#17151D] bg-white shadow-[4px_4px_0_#17151D]">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="border-b-2 border-[#17151D] bg-[#FAF3E8] text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Event</th>
                <th className="px-4 py-2 font-medium">Venue</th>
                <th className="px-4 py-2 font-medium">Starts</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Partner comm.</th>
                <th className="px-4 py-2 text-right font-medium">Consumer comm.</th>
                <th className="px-4 py-2 text-right font-medium">Advance</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((ev) => (
                <EventOverrideRow key={ev.id} event={ev} tenant={tenant} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more events'}
        </button>
      )}
    </section>
  );
}

function EventOverrideRow({
  event,
  tenant,
}: {
  event: AdminTenantEventBillingItem;
  tenant: AdminTenantDetail['tenant'];
}) {
  const update = useUpdateEventBilling();
  const [partner, setPartner] = useState(bpsToPct(event.partnerCommissionBps));
  const [consumer, setConsumer] = useState(bpsToPct(event.consumerCommissionBps));
  const [advance, setAdvance] = useState(bpsToPct(event.advancePayoutBps));
  const hasOverride =
    event.partnerCommissionBps !== null ||
    event.consumerCommissionBps !== null ||
    event.advancePayoutBps !== null;

  const save = () => {
    update.mutate({
      eventId: event.id,
      tenantId: tenant.id,
      patch: {
        partnerCommissionBps: pctToBps(partner),
        consumerCommissionBps: pctToBps(consumer),
        advancePayoutBps: pctToBps(advance),
      },
    });
  };
  const clear = () => {
    setPartner('');
    setConsumer('');
    setAdvance('');
    update.mutate({
      eventId: event.id,
      tenantId: tenant.id,
      patch: { partnerCommissionBps: null, consumerCommissionBps: null, advancePayoutBps: null },
    });
  };

  return (
    <tr>
      <td className="px-4 py-2.5 text-slate-800">{event.name}</td>
      <td className="px-4 py-2.5 text-xs text-slate-500">
        {event.venueName ?? <span className="text-slate-400">Standalone</span>}
      </td>
      <td className="px-4 py-2.5 text-xs text-slate-500">{fmtIST(event.startsAt)}</td>
      <td className="px-4 py-2.5 text-xs text-slate-500">
        {event.status}
        {/* Only reachable under All, which is the one view that mixes them. */}
        {event.archived && (
          <span className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
            archived
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        <PctInput
          value={partner}
          onChange={setPartner}
          placeholder={bpsToPct(tenant.commissionBps) || '0'}
          label={`Partner commission override for ${event.name}`}
        />
      </td>
      <td className="px-4 py-2.5 text-right">
        <PctInput
          value={consumer}
          onChange={setConsumer}
          placeholder={bpsToPct(tenant.consumerCommissionBps) || '0'}
          label={`Consumer commission override for ${event.name}`}
        />
      </td>
      <td className="px-4 py-2.5 text-right">
        <PctInput
          value={advance}
          onChange={setAdvance}
          placeholder={bpsToPct(tenant.advancePayoutBps) || '0'}
          label={`Advance payout override for ${event.name}`}
        />
      </td>
      <td className="px-4 py-2.5 text-right">
        <span className="inline-flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={update.isPending}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={clear}
            disabled={update.isPending || !hasOverride}
            className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 disabled:opacity-40"
          >
            Clear
          </button>
        </span>
      </td>
    </tr>
  );
}

// helpers
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border-2 border-[#17151D] bg-white p-4 shadow-[4px_4px_0_#17151D]">
      <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
      <dl className="space-y-2 text-sm">{children}</dl>
    </section>
  );
}

/**
 * Which gateway settles this org's money, from its country — mirrors the API's
 * selection (apps/api/src/lib/gateway.ts). Venue country can override per
 * venue; this is the org-level default. Circls is the merchant on both rails,
 * so there is no per-tenant gateway account to show.
 */
function gatewayLabel(country: string | null): string {
  const c = (country ?? '').trim().toUpperCase();
  const isUs =
    c === 'US' || c === 'USA' || c === 'UNITED STATES' || c === 'UNITED STATES OF AMERICA';
  // The INR gateway (Razorpay or Cashfree) is a platform-wide API setting
  // (INR_PAYMENT_GATEWAY), not per org — name both rather than guess.
  return isUs ? 'Stripe (USD)' : 'Razorpay / Cashfree (INR)';
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5 last:border-b-0 last:pb-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`text-right text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>
        {value && value !== '' ? value : <span className="text-slate-400">—</span>}
      </dd>
    </div>
  );
}

/**
 * Earnings for one organisation, in a zone drawn from its own venues.
 *
 * Split out because the zone needs the venues list, and fetching it is only
 * worth doing when this tab is actually open — the other tabs have no use for
 * it. While it loads the tab renders in the fallback zone rather than waiting,
 * since the figures are the point and the zone only shifts day boundaries.
 */
function EarningsTabForTenant({ tenantId }: { tenantId: string }) {
  const { data: venues } = useAdminTenantVenues(tenantId, 'active');
  const venueTz = venues?.[0]?.tzName ?? null;
  return <EarningsTab tenantId={tenantId} tz={tenantTz(venueTz)} />;
}
