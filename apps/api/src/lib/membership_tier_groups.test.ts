import { describe, expect, it } from 'vitest';
import {
  assertKnownGroupKeys,
  carryOverGroupKeys,
  customerTierGroups,
  tierGroupsField,
} from './membership_tier_groups.js';

const DAY = { key: 'day-passes', name: 'Day Passes', tagline: 'For first-timers.' };
const PUNCH = { key: 'punch-passes', name: 'Punch Passes', tagline: null };

describe('tierGroupsField', () => {
  it('accepts ordered groups and trims names, dropping an empty tagline', () => {
    const parsed = tierGroupsField.parse([{ key: 'day-passes', name: '  Day Passes ', tagline: '  ' }]);
    expect(parsed).toEqual([{ key: 'day-passes', name: 'Day Passes', tagline: null }]);
  });

  it('rejects duplicate keys and names that differ only in case', () => {
    expect(tierGroupsField.safeParse([DAY, { ...PUNCH, key: 'day-passes' }]).success).toBe(false);
    expect(tierGroupsField.safeParse([DAY, { ...PUNCH, name: 'day passes' }]).success).toBe(false);
  });

  it('only takes link-safe keys', () => {
    expect(tierGroupsField.safeParse([{ ...DAY, key: 'Day Passes' }]).success).toBe(false);
    expect(tierGroupsField.safeParse([{ ...DAY, key: '-day' }]).success).toBe(false);
  });
});

describe('assertKnownGroupKeys', () => {
  it('allows ungrouped plans and known groups, and rejects an unknown one', () => {
    expect(() => assertKnownGroupKeys([DAY], [null, undefined, 'day-passes'])).not.toThrow();
    expect(() => assertKnownGroupKeys([DAY], ['punch-passes'])).toThrow(/no plan group "punch-passes"/);
  });
});

describe('carryOverGroupKeys', () => {
  const previous = [
    { name: 'Day Pass', groupKey: 'day-passes' },
    { name: '5-Visit Pass', groupKey: 'punch-passes' },
  ];

  it("keeps each plan's group when an older app re-sends plans without one", () => {
    const next = carryOverGroupKeys(previous, [{ name: 'Day Pass' }, { name: '5-Visit Pass' }, { name: 'New' }], [
      DAY,
      PUNCH,
    ]);
    expect(next.map((t) => t.groupKey)).toEqual(['day-passes', 'punch-passes', null]);
  });

  it('respects a group the client did send, null included', () => {
    const next = carryOverGroupKeys(previous, [{ name: 'Day Pass', groupKey: null }], [DAY, PUNCH]);
    expect(next[0]!.groupKey).toBeNull();
  });

  it('drops a carried-over group the membership no longer has', () => {
    const next = carryOverGroupKeys(previous, [{ name: '5-Visit Pass' }], [DAY]);
    expect(next[0]!.groupKey).toBeNull();
  });
});

describe('customerTierGroups', () => {
  it('hides empty groups and ungroups plans whose group is gone', () => {
    const shown = customerTierGroups(
      [DAY, PUNCH],
      [
        { id: 'a', groupKey: 'day-passes' },
        { id: 'b', groupKey: 'removed' },
        { id: 'c', groupKey: null },
      ],
    );
    expect(shown.groups).toEqual([DAY]);
    expect(shown.tiers.map((t) => t.groupKey)).toEqual(['day-passes', null, null]);
  });
});
