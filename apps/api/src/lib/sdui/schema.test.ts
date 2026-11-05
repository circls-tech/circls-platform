import { describe, expect, it } from 'vitest';
import { parseScreen, SDUI_MAX_DEPTH, type Node } from './schema.js';

const where = { app: 'consumer', key: 'explore' };

const doc = (root: Node, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  screen: 'consumer.explore',
  root,
  ...extra,
});

describe('SDUI screen schema', () => {
  it('accepts a full document and drops the client-sent version', () => {
    const res = parseScreen(
      doc(
        {
          type: 'column',
          id: 'root',
          props: { padding: 16 },
          children: [
            {
              type: 'hero_banner',
              props: { title: 'Play today' },
              visible: { flag: 'explore.hero', platform: 'ios', minBuild: 12, after: '2026-01-01T00:00:00Z' },
              onTap: { type: 'navigate', route: '/events' },
            },
            { type: 'unknown_widget_from_the_future', onTap: { type: 'sequence', actions: [{ type: 'toast' }] } },
          ],
        },
        { version: 99, minBuild: { ios: 12 }, meta: { owner: 'growth' } },
      ),
      where,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.screen.version).toBeUndefined();
    expect(res.screen.minBuild).toEqual({ ios: 12 });
    expect(res.screen.root.children).toHaveLength(2);
  });

  it('rejects a node without a type, and unknown node keys', () => {
    const noType = parseScreen(doc({ type: '', children: [] }), where);
    expect(noType.ok).toBe(false);
    const extraKey = parseScreen(doc({ type: 'text', colour: 'red' } as unknown as Node), where);
    expect(extraKey.ok).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const res = parseScreen(doc({ type: 'text' }, { layout: 'x' }), where);
    expect(res.ok).toBe(false);
  });

  it('rejects a condition with a key it does not know', () => {
    const res = parseScreen(doc({ type: 'text', visible: { flags: 'x' } as never }), where);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues[0]!.path).toEqual(['root', 'visible']);
  });

  it('accepts nested conditions', () => {
    const res = parseScreen(
      doc({
        type: 'text',
        visible: { not: { any: [{ signedIn: false }, { all: [{ eq: ['a', 'b'] }, { truthy: 1 }] }] } },
      }),
      where,
    );
    expect(res.ok).toBe(true);
  });

  it('rejects a screen name that does not match the route', () => {
    const res = parseScreen({ ...doc({ type: 'text' }), screen: 'consumer.home' }, where);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues).toEqual([{ path: ['screen'], message: 'Expected "consumer.explore"' }]);
  });

  it('limits nesting depth', () => {
    const nest = (depth: number): Node => (depth === 0 ? { type: 'leaf' } : { type: 'box', children: [nest(depth - 1)] });
    expect(parseScreen(doc(nest(SDUI_MAX_DEPTH - 1)), where).ok).toBe(true);
    const tooDeep = parseScreen(doc(nest(SDUI_MAX_DEPTH)), where);
    expect(tooDeep.ok).toBe(false);
    if (tooDeep.ok) return;
    expect(tooDeep.issues[0]!.message).toMatch(/deeper/);
  });

  it('limits body size', () => {
    const res = parseScreen(doc({ type: 'text', props: { body: 'x'.repeat(256 * 1024) } }), where);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues[0]!.message).toMatch(/limit is/);
  });
});
