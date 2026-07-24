'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { useMyProfile, useUpdateMyProfile } from '@/lib/api/consumer';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button, Card, Input } from '@/lib/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function MyProfilePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const profile = useMyProfile();
  const updateProfile = useUpdateMyProfile();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; submit?: string }>({});

  useEffect(() => {
    if (!loading && !user) router.replace('/login?redirect=/me/profile');
  }, [loading, user, router]);

  function startEditing() {
    setName(profile.data?.displayName ?? '');
    setEmail(profile.data?.email ?? '');
    setErrors({});
    setEditing(true);
  }

  async function onSave() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const next: typeof errors = {};
    if (!trimmedName) next.name = 'Please enter your name.';
    if (!trimmedEmail) next.email = 'Please enter your email.';
    else if (!EMAIL_RE.test(trimmedEmail)) next.email = 'That doesn’t look like a valid email.';
    setErrors(next);
    if (next.name || next.email) return;

    try {
      await updateProfile.mutateAsync({ displayName: trimmedName, email: trimmedEmail });
      setEditing(false);
    } catch (e) {
      setErrors({ submit: (e as Error).message });
    }
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-3xl px-4 py-8">
          <p className="text-sm text-text-secondary">Loading…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 font-display text-4xl font-extrabold text-ink">My profile</h1>

        {profile.isLoading ? (
          <p className="text-sm text-text-secondary">Loading your profile…</p>
        ) : profile.isError ? (
          <p className="text-sm font-semibold text-petal-red">
            {profile.error instanceof Error ? profile.error.message : 'Failed to load profile'}
          </p>
        ) : profile.data ? (
          <Card>
            {editing ? (
              <div className="flex flex-col gap-4">
                <Input
                  label="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="name"
                  {...(errors.name ? { error: errors.name } : {})}
                />
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  {...(errors.email ? { error: errors.email } : {})}
                />
                <Input
                  label="Phone"
                  value={profile.data.phoneE164 ?? '—'}
                  disabled
                  readOnly
                  hint="Your phone number is your sign-in and can’t be changed."
                />
                {errors.submit && (
                  <p className="text-xs font-semibold text-petal-red">{errors.submit}</p>
                )}
                <div className="flex gap-2">
                  <Button onClick={onSave} loading={updateProfile.isPending}>Save</Button>
                  <Button
                    variant="secondary"
                    onClick={() => setEditing(false)}
                    disabled={updateProfile.isPending}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <ProfileRow label="Full name" value={profile.data.displayName} />
                <ProfileRow label="Email" value={profile.data.email} />
                <ProfileRow label="Phone" value={profile.data.phoneE164} />
                <div>
                  <Button variant="secondary" onClick={startEditing}>Edit profile</Button>
                </div>
              </div>
            )}
          </Card>
        ) : null}
      </main>
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-display text-xs font-bold uppercase tracking-wide text-ink">
        {label}
      </span>
      <span className={value ? 'text-sm text-ink' : 'text-sm italic text-text-muted'}>
        {value || 'Not set'}
      </span>
    </div>
  );
}
