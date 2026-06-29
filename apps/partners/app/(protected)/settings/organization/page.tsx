'use client';

import Link from 'next/link';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { useOrg } from '@/lib/org_context';
import {
  useRemoveTenantLogo,
  useTenantProfile,
  useUpdateTenantProfile,
  useUploadTenantLogo,
  VENUE_IMAGE_MAX_BYTES,
  VENUE_IMAGE_TYPES,
  type UpdateTenantProfileInput,
} from '@/lib/api/queries';
import { Button, Card, Input } from '@/lib/ui';
import { ConfirmDialog } from '@/components/ConfirmDialog';

const ACCEPT = VENUE_IMAGE_TYPES.join(',');

/** Controlled string state seeded from the loaded profile (null → ''). */
function s(v: string | null | undefined): string {
  return v ?? '';
}

export default function OrganizationSettingsPage() {
  const { activeTenantId } = useOrg();
  const tenantId = activeTenantId ?? '';
  const { data: profile, isLoading } = useTenantProfile(tenantId);
  const update = useUpdateTenantProfile(tenantId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link href="/settings" className="text-sm text-slate-500">
          ← Settings
        </Link>
        <h1 className="text-xl font-semibold text-[#0f172a]">Organisation profile</h1>
      </div>
      <p className="max-w-2xl text-sm text-slate-500">
        This is how your organisation appears to customers across Circls. Add a logo, a short
        description, contact details and your address so people know who they are booking with.
      </p>

      {isLoading && <p className="text-sm text-slate-400">Loading…</p>}
      {!isLoading && !tenantId && (
        <p className="text-sm text-slate-400">Select an organisation first.</p>
      )}
      {!isLoading && profile && (
        <>
          <Card title="Logo">
            <LogoEditor tenantId={tenantId} logoUrl={profile.logoUrl} />
          </Card>
          <OrgProfileForm
            tenantId={tenantId}
            profile={profile}
            saving={update.isPending}
            onSave={(input) => update.mutateAsync(input)}
          />
        </>
      )}
    </div>
  );
}

function LogoEditor({ tenantId, logoUrl }: { tenantId: string; logoUrl: string | null }) {
  const upload = useUploadTenantLogo(tenantId);
  const remove = useRemoveTenantLogo(tenantId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    try {
      await upload.mutateAsync(file);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-[var(--radius)] border border-[#e5e7eb] bg-slate-50">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Organisation logo" className="h-full w-full object-cover" />
          ) : (
            <span className="text-xs text-slate-400">No logo</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {logoUrl ? 'Replace logo' : 'Upload logo'}
            </Button>
            {logoUrl && (
              <Button
                variant="secondary"
                size="sm"
                loading={remove.isPending}
                onClick={() => setConfirmRemove(true)}
              >
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">
            JPEG, PNG or WebP, up to {VENUE_IMAGE_MAX_BYTES / (1024 * 1024)} MB.
          </p>
        </div>
        <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={onFile} />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ConfirmDialog
        open={confirmRemove}
        title="Remove logo?"
        message="This removes your organisation logo. You can upload a new one any time."
        confirmLabel="Remove"
        danger
        onConfirm={() => remove.mutate(undefined, { onError: (e) => setError((e as Error).message) })}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}

interface ProfileShape {
  name: string;
  description: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  websiteUrl: string | null;
  socials: { instagram?: string; facebook?: string; x?: string; youtube?: string } | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

function OrgProfileForm({
  tenantId,
  profile,
  saving,
  onSave,
}: {
  tenantId: string;
  profile: ProfileShape;
  saving: boolean;
  onSave: (input: UpdateTenantProfileInput) => Promise<unknown>;
}) {
  const [name, setName] = useState(s(profile.name));
  const [description, setDescription] = useState(s(profile.description));
  const [contactEmail, setContactEmail] = useState(s(profile.contactEmail));
  const [contactPhone, setContactPhone] = useState(s(profile.contactPhone));
  const [websiteUrl, setWebsiteUrl] = useState(s(profile.websiteUrl));
  const [instagram, setInstagram] = useState(s(profile.socials?.instagram));
  const [facebook, setFacebook] = useState(s(profile.socials?.facebook));
  const [x, setX] = useState(s(profile.socials?.x));
  const [youtube, setYoutube] = useState(s(profile.socials?.youtube));
  const [addressLine1, setAddressLine1] = useState(s(profile.addressLine1));
  const [addressLine2, setAddressLine2] = useState(s(profile.addressLine2));
  const [city, setCity] = useState(s(profile.city));
  const [state, setState] = useState(s(profile.state));
  const [postalCode, setPostalCode] = useState(s(profile.postalCode));
  const [country, setCountry] = useState(s(profile.country));
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Reseed when switching orgs.
  useEffect(() => {
    setSaved(false);
  }, [tenantId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaved(false);
    try {
      await onSave({
        name: name.trim(),
        description,
        contactEmail,
        contactPhone,
        websiteUrl,
        socials: { instagram, facebook, x, youtube },
        addressLine1,
        addressLine2,
        city,
        state,
        postalCode,
        country,
      });
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <Card title="About">
        <div className="flex max-w-2xl flex-col gap-3">
          <Input label="Organisation name" value={name} onChange={(e) => setName(e.target.value)} required />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-[#475569]">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              maxLength={1000}
              className="w-full rounded-[var(--radius)] border border-[#e5e7eb] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#94a3b8] hover:border-slate-300"
              placeholder="Tell customers who you are and what you offer (up to 1000 characters)."
            />
          </div>
        </div>
      </Card>

      <Card title="Contact & links">
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <Input label="Contact email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
          <Input label="Contact phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
          <Input label="Website" placeholder="https://…" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} />
          <Input label="Instagram" value={instagram} onChange={(e) => setInstagram(e.target.value)} />
          <Input label="Facebook" value={facebook} onChange={(e) => setFacebook(e.target.value)} />
          <Input label="X (Twitter)" value={x} onChange={(e) => setX(e.target.value)} />
          <Input label="YouTube" value={youtube} onChange={(e) => setYoutube(e.target.value)} />
        </div>
      </Card>

      <Card title="Address">
        <div className="grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Input label="Address line 1" value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Input label="Address line 2" value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} />
          </div>
          <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <Input label="State" value={state} onChange={(e) => setState(e.target.value)} />
          <Input label="Postal code" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
          <Input label="Country" value={country} onChange={(e) => setCountry(e.target.value)} />
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={saving}>
          Save changes
        </Button>
        {saved && <span className="text-sm text-emerald-600">Saved.</span>}
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
    </form>
  );
}
