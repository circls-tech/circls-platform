/**
 * Loads a payment gateway's browser script (Razorpay, Stripe, Cashfree) once.
 *
 * Concurrent callers share one load. A load that fails, stalls past
 * `timeoutMs`, or runs without defining the gateway's global removes its
 * <script> tag and is forgotten, so the next call starts afresh. (A dead tag
 * left in the page used to make every retry wait on it forever: its load and
 * error events had already fired.)
 */
const loads = new Map<string, Promise<void>>();

export function loadScriptOnce(
  src: string,
  isReady: () => boolean,
  { name, timeoutMs = 30_000 }: { name: string; timeoutMs?: number },
): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('not in browser'));
  if (isReady()) return Promise.resolve();
  const inFlight = loads.get(src);
  if (inFlight) return inFlight;

  const load: Promise<void> = new Promise<void>((resolve, reject) => {
    // A tag from an earlier copy of this module (a dev hot reload) can't be
    // observed any more: replace it.
    document.querySelectorAll(`script[src="${src}"]`).forEach((old) => old.remove());
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) {
        resolve();
        return;
      }
      script.remove();
      if (loads.get(src) === load) loads.delete(src);
      reject(new Error(`Couldn’t load ${name}. Check your connection and try again.`));
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    script.onload = () => settle(isReady());
    script.onerror = () => settle(false);
    document.body.appendChild(script);
  });
  loads.set(src, load);
  return load;
}
