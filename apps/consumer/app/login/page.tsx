'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, type FormEvent, useState } from 'react';
import { Header } from '@/components/Header';
import { useAuth } from '@/lib/firebase/auth_context';
import { Button, Card, Input } from '@/lib/ui';

function friendlyError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? '';
  if (code.includes('invalid-phone-number')) return 'That phone number looks invalid. Use the full number with country code.';
  if (code.includes('invalid-verification-code')) return 'That code is incorrect. Please try again.';
  if (code.includes('code-expired')) return 'That code expired. Request a new one.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Please wait a bit and try again.';
  if (code.includes('captcha')) return 'Verification check failed. Please reload and try again.';
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}

/** Best-effort E.164 normaliser: defaults to India (+91) when no + prefix. */
function toE164(raw: string): string {
  const trimmed = raw.trim().replace(/[\s-]/g, '');
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return `+91${digits}`;
}

function LoginInner() {
  const { startPhoneSignIn, confirmOtp } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const redirect = params.get('redirect') ?? '/';

  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await startPhoneSignIn(toE164(phone));
      setStep('otp');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await confirmOtp(code);
      router.replace(redirect);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto flex max-w-sm flex-col justify-center gap-6 px-4 py-12">
        <h1 className="mb-4 text-center font-display text-3xl font-extrabold text-ink">Welcome back</h1>
        <Card title="Sign in" subtitle="We'll text you a one-time code.">
          {step === 'phone' ? (
            <form onSubmit={handleSendCode} className="flex flex-col gap-4">
              <Input
                label="Phone number"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+91 98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                hint="Include your country code, e.g. +91 for India."
              />
              <Button type="submit" loading={busy} disabled={!phone.trim()}>
                Send code
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="flex flex-col gap-4">
              <Input
                label="Verification code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                hint={`Sent to ${toE164(phone)}`}
              />
              <Button type="submit" loading={busy} disabled={!code.trim()}>
                Verify
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStep('phone');
                  setCode('');
                  setError(null);
                }}
              >
                Use a different number
              </Button>
            </form>
          )}
          {error && <p className="mt-3 text-sm font-semibold text-petal-red">{error}</p>}
        </Card>
      </main>
    </div>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
