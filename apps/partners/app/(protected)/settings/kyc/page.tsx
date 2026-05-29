'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useOrg } from '@/lib/org_context';
import { Badge, Button, Card, Input } from '@/lib/ui';
import type { BadgeTone } from '@/lib/ui/Badge';
import { ApiError } from '@/lib/api/client';
import {
  useKycDocuments,
  useKycStatus,
  usePresignKycUpload,
  useRegisterKycDocument,
  useSubmitKyc,
  type KycDocType,
  type KycStatusValue,
  type PresignResponse,
} from '@/lib/api/kyc';

/**
 * KYC page — Phase 11 (Track B).
 *
 * Two cards:
 *   1. Status — current `kyc_status`, submitted/verified timestamps, Razorpay
 *      Linked Account id. Shows a Submit form when state is `not_started`.
 *   2. Documents — list of already-uploaded files + a small upload widget
 *      (presign → PUT → register).
 *
 * Stub-storage notice: when the presign response has `stub: true` we surface
 * a warning so QA can tell the difference between "really uploaded to R2" and
 * "we registered the row but the bytes went nowhere".
 */

const STATUS_TONE: Record<KycStatusValue, BadgeTone> = {
  not_started: 'neutral',
  submitted: 'open',
  in_review: 'held',
  verified: 'success',
  rejected: 'warning',
};

const STATUS_LABEL: Record<KycStatusValue, string> = {
  not_started: 'Not started',
  submitted: 'Submitted',
  in_review: 'In review',
  verified: 'Verified',
  rejected: 'Rejected',
};

const DOC_TYPES: { value: KycDocType; label: string }[] = [
  { value: 'pan', label: 'PAN' },
  { value: 'gst', label: 'GST certificate' },
  { value: 'bank_proof', label: 'Bank proof' },
  { value: 'aadhaar_front', label: 'Aadhaar (front)' },
  { value: 'aadhaar_back', label: 'Aadhaar (back)' },
  { value: 'address', label: 'Address proof' },
  { value: 'other', label: 'Other' },
];

function formatBytes(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function StubNotice() {
  return (
    <div className="rounded-[var(--radius)] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <strong className="font-semibold">Stub storage</strong> — uploads are not
      persisted yet. The R2 client will be wired up when the bucket is
      provisioned (Phase 11 ops checklist). For now you can practice the form
      flow; the file bytes go nowhere.
    </div>
  );
}

function StatusCard({ tenantId }: { tenantId: string }) {
  const { data, isLoading, isError } = useKycStatus(tenantId);
  const submitMut = useSubmitKyc(tenantId);

  // Submit-form state. We keep everything as plain strings (no react-hook-form
  // overhead) because the page is small and the validation lives server-side.
  const [legalName, setLegalName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [pan, setPan] = useState('');
  const [gstin, setGstin] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');
  const [bankHolder, setBankHolder] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  if (isLoading) {
    return (
      <Card title="KYC status">
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }
  if (isError || !data) {
    return (
      <Card title="KYC status">
        <p className="text-sm text-red-500">Failed to load KYC status.</p>
      </Card>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!legalName.trim() || !email.trim()) {
      setFormError('Legal name and email are required.');
      return;
    }
    try {
      await submitMut.mutateAsync({
        legalName: legalName.trim(),
        email: email.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(pan.trim() ? { pan: pan.trim().toUpperCase() } : {}),
        ...(gstin.trim() ? { gstin: gstin.trim().toUpperCase() } : {}),
        ...(bankAccount.trim() && bankIfsc.trim() && bankHolder.trim()
          ? {
              bank: {
                accountNumber: bankAccount.trim(),
                ifsc: bankIfsc.trim().toUpperCase(),
                holderName: bankHolder.trim(),
              },
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError('Submission failed. Please try again.');
      }
    }
  }

  return (
    <Card
      title="KYC status"
      subtitle="Submit your business details to open a Razorpay Linked Account."
    >
      <div className="flex flex-wrap items-center gap-3 pb-4">
        <span className="text-sm text-slate-500">Status:</span>
        <Badge tone={STATUS_TONE[data.status]} label={STATUS_LABEL[data.status]} />
        {data.razorpayLinkedAccountId && (
          <Badge
            tone="neutral"
            label={`Razorpay: ${data.razorpayLinkedAccountId}`}
            className="font-mono"
          />
        )}
      </div>

      <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Submitted at (IST)
          </dt>
          <dd className="text-slate-700">{formatDateTime(data.submittedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Verified at (IST)
          </dt>
          <dd className="text-slate-700">{formatDateTime(data.verifiedAt)}</dd>
        </div>
        {data.rejectionReason && (
          <div className="md:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-red-500">
              Rejection reason
            </dt>
            <dd className="text-red-700">{data.rejectionReason}</dd>
          </div>
        )}
      </dl>

      {data.status === 'not_started' && (
        <form className="mt-6 flex flex-col gap-4" onSubmit={onSubmit}>
          <h3 className="text-sm font-semibold text-slate-700">Submit KYC</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Input
              label="Legal entity name *"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Acme Sports Pvt Ltd"
              required
            />
            <Input
              label="Contact email *"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ops@acme.com"
              required
            />
            <Input
              label="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 90000 00000"
            />
            <Input
              label="PAN"
              value={pan}
              onChange={(e) => setPan(e.target.value.toUpperCase())}
              placeholder="ABCDE1234F"
              maxLength={10}
            />
            <Input
              label="GSTIN"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="22ABCDE1234F1Z5"
              maxLength={15}
            />
          </div>
          <h4 className="mt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Bank details (optional now, required for payouts)
          </h4>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Input
              label="Account number"
              value={bankAccount}
              onChange={(e) => setBankAccount(e.target.value)}
              placeholder="XXXXXXXXXX"
            />
            <Input
              label="IFSC"
              value={bankIfsc}
              onChange={(e) => setBankIfsc(e.target.value.toUpperCase())}
              placeholder="HDFC0000001"
              maxLength={11}
            />
            <Input
              label="Account holder name"
              value={bankHolder}
              onChange={(e) => setBankHolder(e.target.value)}
              placeholder="Acme Sports Pvt Ltd"
            />
          </div>
          {formError && (
            <p className="text-xs text-red-600" role="alert">
              {formError}
            </p>
          )}
          <div>
            <Button type="submit" loading={submitMut.isPending}>
              Submit KYC
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function DocumentsCard({ tenantId }: { tenantId: string }) {
  const { data: docs = [], isLoading, isError } = useKycDocuments(tenantId);
  const presignMut = usePresignKycUpload(tenantId);
  const registerMut = useRegisterKycDocument(tenantId);

  const [docType, setDocType] = useState<KycDocType>('pan');
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastStub, setLastStub] = useState<boolean | null>(null);

  async function performPut(presigned: PresignResponse, body: File) {
    if (presigned.uploadUrl.startsWith('stub://')) {
      // Stub backend — nothing to upload to. The UI surface tells the user.
      return;
    }
    const res = await fetch(presigned.uploadUrl, {
      method: 'PUT',
      headers: presigned.headers,
      body,
    });
    if (!res.ok) {
      throw new Error(`Storage PUT failed: ${res.status} ${res.statusText}`);
    }
  }

  async function onUpload(e: React.FormEvent) {
    e.preventDefault();
    setUploadError(null);
    if (!file) {
      setUploadError('Pick a file first.');
      return;
    }
    try {
      const presigned = await presignMut.mutateAsync({
        docType,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });
      setLastStub(presigned.stub);
      await performPut(presigned, file);
      await registerMut.mutateAsync({
        docType,
        storageKey: presigned.storageKey,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });
      setFile(null);
      // Reset native file input by clearing the form.
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      if (err instanceof ApiError) {
        setUploadError(err.message);
      } else if (err instanceof Error) {
        setUploadError(err.message);
      } else {
        setUploadError('Upload failed.');
      }
    }
  }

  return (
    <Card
      title="KYC documents"
      subtitle="Upload PAN, GST, bank-proof, etc. Presigned URLs expire in a few minutes."
    >
      {lastStub === true && <div className="mb-4"><StubNotice /></div>}

      <form className="flex flex-wrap items-end gap-3" onSubmit={onUpload}>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Document type
          </label>
          <select
            value={docType}
            onChange={(e) => setDocType(e.target.value as KycDocType)}
            className="rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-slate-700"
          >
            {DOC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
            File
          </label>
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm text-slate-700"
          />
        </div>
        <Button
          type="submit"
          loading={presignMut.isPending || registerMut.isPending}
        >
          Upload
        </Button>
      </form>
      {uploadError && (
        <p className="mt-2 text-xs text-red-600" role="alert">{uploadError}</p>
      )}

      <div className="mt-6">
        {isLoading && <p className="text-sm text-slate-400">Loading documents…</p>}
        {isError && <p className="text-sm text-red-500">Failed to load documents.</p>}
        {!isLoading && !isError && docs.length === 0 && (
          <p className="text-sm text-slate-400">No documents uploaded yet.</p>
        )}
        {!isLoading && !isError && docs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e5e7eb] text-left">
                  <th className="pb-2 pr-4 font-medium text-slate-500">Type</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Mime</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Size</th>
                  <th className="pb-2 pr-4 font-medium text-slate-500">Uploaded</th>
                  <th className="pb-2 font-medium text-slate-500">Key</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f1f5f9]">
                {docs.map((d) => (
                  <tr key={d.id} className="align-top">
                    <td className="py-2.5 pr-4 text-slate-700">{d.docType}</td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500">
                      {d.mimeType ?? '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500">
                      {formatBytes(d.sizeBytes)}
                    </td>
                    <td className="py-2.5 pr-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatDateTime(d.uploadedAt)}
                    </td>
                    <td className="py-2.5 font-mono text-xs text-slate-400 break-all">
                      {d.storageKey}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

export default function KycPage() {
  const { activeTenantId } = useOrg();

  if (!activeTenantId) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <Link
            href="/settings"
            className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
          >
            &larr; Settings
          </Link>
          <h1 className="text-xl font-semibold text-[#0f172a]">KYC</h1>
        </div>
        <Card title="KYC">
          <p className="text-sm text-slate-400">No active tenant selected.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Link
          href="/settings"
          className="text-sm text-slate-500 hover:text-slate-800 transition-colors"
        >
          &larr; Settings
        </Link>
        <h1 className="text-xl font-semibold text-[#0f172a]">KYC</h1>
      </div>
      <StatusCard tenantId={activeTenantId} />
      <DocumentsCard tenantId={activeTenantId} />
    </div>
  );
}
