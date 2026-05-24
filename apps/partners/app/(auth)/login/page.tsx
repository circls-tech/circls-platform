'use client';
import type { ConfirmationResult } from 'firebase/auth';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useAuth } from '@/lib/firebase/auth_context';

export default function LoginPage() {
  const { sendOtp } = useAuth();
  const router = useRouter();
  const [phone, setPhone] = useState('+91');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setConfirmation(await sendOtp(phone.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send OTP');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    if (!confirmation) return;
    setBusy(true);
    setError(null);
    try {
      await confirmation.confirm(code.trim());
      router.replace('/dashboard');
    } catch {
      setError('Invalid code — try again');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Circls Partner Portal</h1>
      {!confirmation ? (
        <form onSubmit={handleSend} className="flex flex-col gap-3">
          <label className="text-sm font-medium" htmlFor="phone">
            Phone number
          </label>
          <input
            id="phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91…"
            inputMode="tel"
            className="rounded border border-gray-300 px-3 py-2"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? 'Sending…' : 'Send OTP'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerify} className="flex flex-col gap-3">
          <label className="text-sm font-medium" htmlFor="code">
            Enter the 6-digit code
          </label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            inputMode="numeric"
            className="rounded border border-gray-300 px-3 py-2 tracking-widest"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {busy ? 'Verifying…' : 'Verify & sign in'}
          </button>
        </form>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
