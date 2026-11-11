import { describe, expect, it } from 'vitest';
import { manifestScreens, minBuildSatisfied, selectPublished } from './select.js';

const row = (version: number, minBuild: Record<string, number> = {}, schemaVersion = 1, status = 'published') => ({
  key: 'explore',
  version,
  status,
  schemaVersion,
  minBuild,
});

describe('SDUI version selection', () => {
  it('minBuild gates per platform, with * applying to every platform', () => {
    expect(minBuildSatisfied({ ios: 12 }, { platform: 'ios', build: 11 })).toBe(false);
    expect(minBuildSatisfied({ ios: 12 }, { platform: 'ios', build: 12 })).toBe(true);
    expect(minBuildSatisfied({ ios: 12 }, { platform: 'android', build: 1 })).toBe(true);
    expect(minBuildSatisfied({ '*': 5 }, { platform: 'android', build: 4 })).toBe(false);
    expect(minBuildSatisfied({ '*': 5, android: 7 }, { platform: 'android', build: 6 })).toBe(false);
    // No build given (a curl, the admin): nothing is gated.
    expect(minBuildSatisfied({ ios: 12 }, { platform: 'ios' })).toBe(true);
  });

  it('picks the highest published version the build may render', () => {
    const rows = [row(1), row(2, { ios: 10 }), row(3, { ios: 20 }), row(4, {}, 1, 'draft'), row(5, {}, 1, 'archived')];
    expect(selectPublished(rows, { platform: 'ios', build: 15 })?.version).toBe(2);
    expect(selectPublished(rows, { platform: 'ios', build: 25 })?.version).toBe(3);
    expect(selectPublished(rows, { platform: 'android', build: 1 })?.version).toBe(3);
    expect(selectPublished(rows, { platform: 'ios', build: 5 })?.version).toBe(1);
  });

  it('skips schema versions the client cannot render', () => {
    const rows = [row(1, {}, 1), row(2, {}, 2)];
    expect(selectPublished(rows, { platform: 'ios', build: 1 })?.version).toBe(1);
    expect(selectPublished(rows, { platform: 'ios', build: 1, schema: 2 })?.version).toBe(2);
    expect(selectPublished([row(1, {}, 3)], { schema: 2 })).toBeUndefined();
  });

  it('builds the manifest per key, leaving out screens with nothing renderable', () => {
    const rows = [
      row(1),
      row(2, { ios: 20 }),
      { ...row(7, { android: 3 }), key: 'home' },
      { ...row(1, {}, 2), key: 'more_menu' },
    ];
    expect(manifestScreens(rows, { platform: 'ios', build: 10 })).toEqual({
      explore: { version: 1 },
      home: { version: 7 },
    });
  });
});
