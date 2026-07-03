'use client';

import { useState } from 'react';
import { useUpdateMyProfile } from '@/lib/api/consumer';
import { Button, Input } from '@/lib/ui';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One-time pre-payment step: a first-time booker has only a phone number on
 * file, so we collect their name + email here and save them to the profile.
 * Once the profile carries both, CheckoutModal never shows this again.
 */
export function ContactDetailsForm({
  initialName,
  initialEmail,
}: {
  initialName: string;
  initialEmail: string;
}) {
  const updateProfile = useUpdateMyProfile();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [errors, setErrors] = useState<{ name?: string; email?: string; submit?: string }>({});

  async function onContinue() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const next: typeof errors = {};
    if (!trimmedName) next.name = 'Please enter your name.';
    if (!trimmedEmail) next.email = 'Please enter your email.';
    else if (!EMAIL_RE.test(trimmedEmail)) next.email = 'That doesn’t look like a valid email.';
    setErrors(next);
    if (next.name || next.email) return;

    try {
      // On success useUpdateMyProfile writes the fresh profile into the query
      // cache, which flips CheckoutModal's gate straight to the payment view.
      await updateProfile.mutateAsync({ displayName: trimmedName, email: trimmedEmail });
    } catch (e) {
      setErrors({ submit: (e as Error).message });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Before your first booking, tell us who to put it under. We’ll use this for
        receipts and booking updates — you’ll only do this once.
      </p>
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
      {errors.submit && <p className="text-xs font-semibold text-petal-red">{errors.submit}</p>}
      <Button className="mt-1" onClick={onContinue} loading={updateProfile.isPending}>
        Continue to payment
      </Button>
    </div>
  );
}
