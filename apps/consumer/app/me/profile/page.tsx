'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { useMyProfile, useUpdateMyProfile, useUsernameAvailable } from '@/lib/api/consumer';
import { ApiError } from '@/lib/api/client';
import { useAuth } from '@/lib/firebase/auth_context';
import { INTEREST_CATEGORIES } from '@/lib/interests';
import { Button, Card, Input } from '@/lib/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Mirrors the API's username rule: 3–30 chars, letters/digits/underscores,
 * starting with a letter or digit. Case-insensitive (stored lowercase). */
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_]{2,29}$/;

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function MyProfilePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const profile = useMyProfile();
  const updateProfile = useUpdateMyProfile();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [interests, setInterests] = useState<string[]>([]);
  const [errors, setErrors] = useState<{
    name?: string;
    email?: string;
    username?: string;
    submit?: string;
  }>({});

  useEffect(() => {
    if (!loading && !user) router.replace('/login?redirect=/me/profile');
  }, [loading, user, router]);

  function startEditing() {
    setName(profile.data?.displayName ?? '');
    setUsername(profile.data?.username ?? '');
    setEmail(profile.data?.email ?? '');
    setInterests(profile.data?.interests ?? []);
    setErrors({});
    setEditing(true);
  }

  // Live "is it free?" check while the user types a new handle.
  const trimmedUsername = username.trim();
  const usernameChanged =
    editing && trimmedUsername.toLowerCase() !== (profile.data?.username ?? '');
  const usernameFormatOk = USERNAME_RE.test(trimmedUsername);
  const debouncedUsername = useDebounced(trimmedUsername, 350);
  const availability = useUsernameAvailable(
    debouncedUsername,
    usernameChanged && USERNAME_RE.test(debouncedUsername) && debouncedUsername === trimmedUsername,
  );
  const usernameTaken =
    usernameChanged && availability.data?.valid === true && !availability.data.available;
  const usernameLiveError =
    trimmedUsername.length > 0 && !usernameFormatOk
      ? '3–30 characters: letters, numbers and underscores, starting with a letter or number.'
      : usernameTaken
        ? 'That username is already taken.'
        : undefined;
  const usernameHint =
    usernameChanged && usernameFormatOk && availability.data?.available
      ? `@${trimmedUsername.toLowerCase()} is available ✓`
      : 'Your unique public handle on circls. Once set, it identifies you everywhere.';

  const toggleInterest = (slug: string) =>
    setInterests((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );

  const interestsChanged =
    JSON.stringify([...interests].sort()) !==
    JSON.stringify([...(profile.data?.interests ?? [])].sort());

  async function onSave() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const next: typeof errors = {};
    if (!trimmedName) next.name = 'Please enter your name.';
    if (!trimmedEmail) next.email = 'Please enter your email.';
    else if (!EMAIL_RE.test(trimmedEmail)) next.email = 'That doesn’t look like a valid email.';
    if (trimmedUsername && !usernameFormatOk)
      next.username = '3–30 characters: letters, numbers and underscores, starting with a letter or number.';
    else if (usernameTaken) next.username = 'That username is already taken.';
    setErrors(next);
    if (next.name || next.email || next.username) return;

    // Only send fields that changed — a stale unchanged value can never
    // trip a uniqueness conflict that way.
    const patch: {
      displayName?: string;
      email?: string;
      username?: string;
      interests?: string[];
    } = {};
    if (trimmedName !== (profile.data?.displayName ?? '')) patch.displayName = trimmedName;
    if (trimmedEmail !== (profile.data?.email ?? '')) patch.email = trimmedEmail;
    if (usernameChanged && trimmedUsername) patch.username = trimmedUsername;
    if (interestsChanged) patch.interests = interests;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }

    try {
      await updateProfile.mutateAsync(patch);
      setEditing(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'username_taken') {
        setErrors({ username: 'That username was just taken by someone else — try another.' });
      } else {
        setErrors({ submit: (e as Error).message });
      }
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
          <div className="flex flex-col gap-5">
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
                    label="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. priya_plays"
                    maxLength={30}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    hint={usernameHint}
                    {...(errors.username ?? usernameLiveError
                      ? { error: errors.username ?? usernameLiveError }
                      : {})}
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
                  <InterestPicker selected={interests} onToggle={toggleInterest} />
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
                  <ProfileRow
                    label="Username"
                    value={profile.data.username ? `@${profile.data.username}` : null}
                  />
                  <ProfileRow label="Email" value={profile.data.email} />
                  <ProfileRow label="Phone" value={profile.data.phoneE164} />
                  <div className="flex flex-col gap-1.5">
                    <span className="font-display text-xs font-bold uppercase tracking-wide text-ink">
                      Interests
                    </span>
                    {profile.data.interests.length === 0 ? (
                      <span className="text-sm italic text-text-muted">
                        Not set — tell us what you’re into and we’ll tailor recommendations.
                      </span>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {INTEREST_CATEGORIES.filter((c) =>
                          profile.data!.interests.includes(c.slug),
                        ).map((c) => (
                          <span
                            key={c.slug}
                            className="inline-flex items-center gap-1.5 rounded-full border-[2.5px] border-ink bg-coral px-3.5 py-1.5 font-display text-xs font-bold text-ink"
                          >
                            <span aria-hidden>{c.emoji}</span>
                            <span>{c.label}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <Button variant="secondary" onClick={startEditing}>Edit profile</Button>
                  </div>
                </div>
              )}
            </Card>
          </div>
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

function InterestPicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (slug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-display text-xs font-bold uppercase tracking-wide text-ink">
        Interests
      </span>
      <p className="text-xs text-text-muted">
        Pick what you’re into — we’ll use this to recommend venues and events.
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {INTEREST_CATEGORIES.map((cat) => {
          const isSelected = selected.includes(cat.slug);
          return (
            <button
              key={cat.slug}
              type="button"
              onClick={() => onToggle(cat.slug)}
              aria-pressed={isSelected}
              className={[
                'inline-flex items-center gap-1.5 rounded-full border-[2.5px] px-3.5 py-1.5',
                'font-display text-xs font-bold transition-colors duration-100',
                isSelected
                  ? 'border-ink bg-coral text-ink shadow-offset-sm'
                  : 'border-ink/30 bg-white text-ink-soft hover:border-ink hover:text-ink',
              ].join(' ')}
            >
              <span aria-hidden>{cat.emoji}</span>
              <span>{cat.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
