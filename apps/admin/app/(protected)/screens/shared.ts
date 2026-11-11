import { ApiError } from '@/lib/api/client';

export const inputCls = 'mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm';
export const cardCls = 'rounded-lg border-2 border-[#17151D] bg-white p-4 shadow-[4px_4px_0_#17151D]';
export const primaryBtn =
  'rounded-md border-2 border-[#17151D] bg-brand-600 px-3 py-1.5 text-xs font-bold text-[#17151D] shadow-[2px_2px_0_#17151D] transition-transform hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0';
export const plainBtn =
  'rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50';
export const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const KEY_RE = /^[a-z0-9_]{1,64}$/;
export const RESERVED_KEYS = ['manifest', 'flags', 'update'];

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your role can view screens but not change them.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
