import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', GATEWAY_HTTP_TIMEOUT_MS: 50 },
}));

import { GatewayHttpError, gatewayRequest } from './gateway_http.js';

afterEach(() => vi.unstubAllGlobals());

const request = () =>
  gatewayRequest<{ ok: boolean }>({
    provider: 'cashfree',
    label: 'Cashfree',
    method: 'POST',
    baseUrl: 'https://gw.example',
    path: '/orders',
    headers: { 'x-test': '1' },
    body: '{}',
    errorMessage: (b) => (b as { message?: string }).message,
  });

async function failure(): Promise<GatewayHttpError> {
  try {
    await request();
  } catch (err) {
    if (err instanceof GatewayHttpError) return err;
    throw err;
  }
  throw new Error('expected the request to fail');
}

describe('gatewayRequest', () => {
  it('returns the parsed body and always sends a timeout signal', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request()).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gw.example/orders');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a 5xx is an outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"down"}', { status: 503 })));
    const err = await failure();
    expect(err.outage).toBe(true);
    expect(err.status).toBe(503);
    expect(err.message).toBe('Cashfree /orders failed (503): down');
  });

  it('a 429 is an outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    expect((await failure()).outage).toBe(true);
  });

  it('a 4xx refusal is not an outage and carries the provider message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"order_amount : invalid value"}', { status: 400 })),
    );
    const err = await failure();
    expect(err.outage).toBe(false);
    expect(err.message).toContain('order_amount : invalid value');
  });

  it('a timeout is an outage with no status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );
    const err = await failure();
    expect(err.outage).toBe(true);
    expect(err.status).toBeNull();
    expect(err.message).toBe('Cashfree /orders timed out');
  });

  it('a network error is an outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = await failure();
    expect(err.outage).toBe(true);
    expect(err.message).toContain('unreachable: fetch failed');
  });

  it('really aborts a gateway that never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    const err = await failure();
    expect(err.outage).toBe(true);
    expect(err.message).toBe('Cashfree /orders timed out');
  });
});
