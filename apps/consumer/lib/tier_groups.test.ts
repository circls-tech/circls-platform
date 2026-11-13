import { describe, expect, it } from 'vitest';
import { UNGROUPED_TAB, tierTabs } from './tier_groups';

const DAY = { key: 'day-passes', name: 'Day Passes', tagline: 'For first-timers.' };
const PUNCH = { key: 'punch-passes', name: 'Punch Passes', tagline: null };
const tier = (id: string, pricePaise: number, groupKey: string | null) => ({ id, pricePaise, groupKey });

describe('tierTabs', () => {
  it('makes a tab per group, in order, priced from its cheapest tier', () => {
    const tabs = tierTabs([DAY, PUNCH], [tier('a', 65000, 'day-passes'), tier('b', 275000, 'punch-passes'), tier('c', 40000, 'day-passes')]);
    expect(tabs.map((t) => [t.key, t.tiers.map((x) => x.id), t.fromPaise])).toEqual([
      ['day-passes', ['a', 'c'], 40000],
      ['punch-passes', ['b'], 275000],
    ]);
    expect(tabs[0]!.tagline).toBe('For first-timers.');
    expect(tabs.map((t) => t.tint)).toEqual(['bg-pastel-salmon', 'bg-pastel-pink']);
  });

  it('puts tiers outside every group in a last tab, and skips empty groups', () => {
    const tabs = tierTabs([DAY, PUNCH], [tier('a', 1, 'day-passes'), tier('b', 2, null), tier('c', 3, 'gone')]);
    expect(tabs.map((t) => [t.key, t.tiers.map((x) => x.id)])).toEqual([
      ['day-passes', ['a']],
      [UNGROUPED_TAB, ['b', 'c']],
    ]);
  });

  it('shows no tabs without groups, or when only ungrouped tiers remain', () => {
    expect(tierTabs(undefined, [tier('a', 1, null)])).toEqual([]);
    expect(tierTabs([], [tier('a', 1, null)])).toEqual([]);
    expect(tierTabs([DAY], [tier('a', 1, null)])).toEqual([]);
  });

  it('copes with tiers from an API that predates groups', () => {
    expect(tierTabs([DAY], [{ id: 'a', pricePaise: 1 }])).toEqual([]);
  });
});
