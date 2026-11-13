import { describe, expect, it } from 'vitest';
import { moveItem, resolveTierGroups, tierGroupDraftsFrom, tiersByGroup, type TierGroupDraft } from './tier_groups';

function draft(localId: string, name: string, key: string | null = null, tagline = ''): TierGroupDraft {
  return { localId, key, name, tagline };
}

describe('resolveTierGroups', () => {
  it('gives a new group its name as a slug, unique among the others', () => {
    const { groups, keyOf } = resolveTierGroups([
      draft('a', 'Day Passes'),
      draft('b', 'Punch passes', 'day-passes'),
      draft('c', 'Climbing Classes – 2×/Week'),
    ]);
    // 'day-passes' is taken by the saved group, so the new one gets a suffix.
    expect(groups.map((g) => g.key)).toEqual(['day-passes-2', 'day-passes', 'climbing-classes-2-week']);
    expect(keyOf('a')).toBe('day-passes-2');
    expect(keyOf('b')).toBe('day-passes');
    expect(keyOf(null)).toBeNull();
  });

  it('keeps a saved key on rename, so links to the tab keep working', () => {
    const { groups } = resolveTierGroups([draft('punch', 'Punch cards', 'punch')]);
    expect(groups).toEqual([{ key: 'punch', name: 'Punch cards', tagline: null }]);
  });

  it('leaves out unnamed groups and ungroups their tiers', () => {
    const { groups, keyOf } = resolveTierGroups([draft('a', '  '), draft('b', 'Classes', null, ' Learn ')]);
    expect(groups).toEqual([{ key: 'classes', name: 'Classes', tagline: 'Learn' }]);
    expect(keyOf('a')).toBeNull();
  });

  it('falls back to a generic key when a name has no letters or digits', () => {
    expect(resolveTierGroups([draft('a', '★★★')]).groups[0]!.key).toBe('group');
  });
});

describe('tierGroupDraftsFrom', () => {
  it('uses the saved key as the local id, which is what tiers point at', () => {
    expect(tierGroupDraftsFrom([{ key: 'day', name: 'Day', tagline: null }])).toEqual([
      { localId: 'day', key: 'day', name: 'Day', tagline: '' },
    ]);
    expect(tierGroupDraftsFrom(undefined)).toEqual([]);
  });
});

describe('tiersByGroup', () => {
  it('lists tiers under their groups in order, ungrouped ones last', () => {
    const sections = tiersByGroup(
      [
        { key: 'day', name: 'Day', tagline: null },
        { key: 'punch', name: 'Punch', tagline: null },
      ],
      [
        { id: 1, groupKey: 'punch' },
        { id: 2, groupKey: null },
        { id: 3, groupKey: 'day' },
        { id: 4, groupKey: 'gone' },
      ],
    );
    expect(sections.map((s) => [s.group?.key ?? null, s.tiers.map((t) => t.id)])).toEqual([
      ['day', [3]],
      ['punch', [1]],
      [null, [2, 4]],
    ]);
  });
});

describe('moveItem', () => {
  it('moves an item, and does nothing past either end', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
