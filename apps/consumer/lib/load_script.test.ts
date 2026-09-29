import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadScriptOnce } from './load_script';

/** Just enough of a DOM for the loader: script tags in a list. */
class FakeScript {
  src = '';
  async = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  remove() {
    const i = page.scripts.indexOf(this);
    if (i >= 0) page.scripts.splice(i, 1);
  }
}
const page = { scripts: [] as FakeScript[] };
const fakeDocument = {
  createElement: () => new FakeScript(),
  querySelectorAll: (selector: string) =>
    page.scripts.filter((s) => selector === `script[src="${s.src}"]`),
  body: { appendChild: (s: FakeScript) => page.scripts.push(s) },
};

let ready = false;
let n = 0;
/** A fresh URL per test: the loader remembers loads by src. */
const nextSrc = () => `https://gateway.test/sdk-${++n}.js`;
const tag = (src: string) => page.scripts.filter((s) => s.src === src);

beforeEach(() => {
  page.scripts = [];
  ready = false;
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', fakeDocument);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loadScriptOnce', () => {
  it('shares one tag between concurrent callers', async () => {
    const src = nextSrc();
    const a = loadScriptOnce(src, () => ready, { name: 'Gateway' });
    const b = loadScriptOnce(src, () => ready, { name: 'Gateway' });
    expect(tag(src)).toHaveLength(1);
    ready = true;
    tag(src)[0]!.onload!();
    await expect(Promise.all([a, b])).resolves.toBeDefined();
  });

  it('resolves at once when the gateway is already loaded', async () => {
    ready = true;
    const src = nextSrc();
    await loadScriptOnce(src, () => ready, { name: 'Gateway' });
    expect(tag(src)).toHaveLength(0);
  });

  it('a failed load removes its tag, and the next call starts afresh', async () => {
    const src = nextSrc();
    const first = loadScriptOnce(src, () => ready, { name: 'Gateway' });
    tag(src)[0]!.onerror!();
    await expect(first).rejects.toThrow('Couldn’t load Gateway');
    expect(tag(src)).toHaveLength(0);

    const retry = loadScriptOnce(src, () => ready, { name: 'Gateway' });
    expect(tag(src)).toHaveLength(1);
    ready = true;
    tag(src)[0]!.onload!();
    await expect(retry).resolves.toBeUndefined();
  });

  it('a load that stalls times out and can be retried', async () => {
    vi.useFakeTimers();
    const src = nextSrc();
    const stalled = loadScriptOnce(src, () => ready, { name: 'Gateway', timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    await expect(stalled).rejects.toThrow('Couldn’t load Gateway');
    expect(tag(src)).toHaveLength(0);
    loadScriptOnce(src, () => ready, { name: 'Gateway' }).catch(() => {});
    expect(tag(src)).toHaveLength(1);
  });

  it('a script that runs without defining the gateway is a failure', async () => {
    const src = nextSrc();
    const load = loadScriptOnce(src, () => ready, { name: 'Gateway' });
    tag(src)[0]!.onload!();
    await expect(load).rejects.toThrow('Couldn’t load Gateway');
    expect(tag(src)).toHaveLength(0);
  });
});
