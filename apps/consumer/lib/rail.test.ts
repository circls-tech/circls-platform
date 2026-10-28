import { describe, expect, it } from 'vitest';
import { railCardsPerPage, railCurrentIndex, railEdges, railTargetIndex } from './rail';

describe('railEdges', () => {
  it('can only go forward at the start of a rail that overflows', () => {
    expect(railEdges(0, 2000, 1280)).toEqual({ canPrev: false, canNext: true });
  });

  it('can go both ways part-way along', () => {
    expect(railEdges(400, 2000, 1280)).toEqual({ canPrev: true, canNext: true });
  });

  it('can only go back at the end', () => {
    expect(railEdges(720, 2000, 1280)).toEqual({ canPrev: true, canNext: false });
  });

  it('treats a sub-pixel shortfall at either end as the end', () => {
    expect(railEdges(719.5, 2000, 1280)).toEqual({ canPrev: true, canNext: false });
    expect(railEdges(0.5, 2000, 1280)).toEqual({ canPrev: false, canNext: true });
  });

  it('goes nowhere when every card fits', () => {
    expect(railEdges(0, 900, 1280)).toEqual({ canPrev: false, canNext: false });
  });
});

describe('railCardsPerPage', () => {
  it('counts the four cards that fill a desktop column', () => {
    expect(railCardsPerPage(1120, 265, 20)).toBe(4);
  });

  it('still counts four when the card width is fractional', () => {
    // A 1090px window: four 245.75px cards fill a 1043px column.
    expect(railCardsPerPage(1043, 245.75, 20)).toBe(4);
  });

  it('still counts four when a measurement rounded the card width up', () => {
    // offsetWidth reports that 245.75px card as 246px.
    expect(railCardsPerPage(1043, 246, 20)).toBe(4);
  });

  it('leaves out a card that only peeks in', () => {
    // A 736px tablet column shows two 260px cards and part of a third.
    expect(railCardsPerPage(736, 260, 16)).toBe(2);
  });

  it('counts at least one card when not even one fits', () => {
    expect(railCardsPerPage(200, 260, 16)).toBe(1);
  });

  it('counts one card when cards have no size', () => {
    expect(railCardsPerPage(800, 0, 0)).toBe(1);
  });
});

describe('railCurrentIndex', () => {
  const offsets = [0, 285, 570, 855, 1140, 1425, 1710, 1995, 2280, 2565];

  it('picks the card whose snap offset is nearest', () => {
    expect(railCurrentIndex(0, 1710, offsets, 4)).toBe(0);
    expect(railCurrentIndex(1150, 1710, offsets, 4)).toBe(4);
    expect(railCurrentIndex(420, 1710, offsets, 4)).toBe(1);
  });

  it('is the last page at the end of the rail, even between snap offsets', () => {
    // Three 260px cards per tablet page; the end stops short of card 7's offset.
    const tablet = [0, 276, 552, 828, 1104, 1380, 1656, 1932, 2208, 2484];
    expect(railCurrentIndex(1891, 1891, tablet, 3)).toBe(7);
  });

  it('starts at the first card on an empty rail', () => {
    expect(railCurrentIndex(0, 0, [], 4)).toBe(0);
  });
});

describe('railTargetIndex', () => {
  it('pages forward by whole pages and pins the last page to the end', () => {
    // Ten cards, four per page: 1–4, 5–8, then 7–10.
    expect(railTargetIndex(0, 1, 4, 10)).toBe(4);
    expect(railTargetIndex(4, 1, 4, 10)).toBe(6);
    expect(railTargetIndex(6, 1, 4, 10)).toBe(6);
  });

  it('retraces the forward pages going back', () => {
    // 7–10, then 5–8 (not 3–6), then 1–4.
    expect(railTargetIndex(6, -1, 4, 10)).toBe(4);
    expect(railTargetIndex(4, -1, 4, 10)).toBe(0);
    expect(railTargetIndex(0, -1, 4, 10)).toBe(0);
  });

  it('snaps a rail swiped part-way back onto the page grid', () => {
    expect(railTargetIndex(5, 1, 4, 10)).toBe(6);
    expect(railTargetIndex(5, -1, 4, 10)).toBe(4);
    expect(railTargetIndex(3, -1, 4, 10)).toBe(0);
  });

  it('stays put when every card fits on one page', () => {
    expect(railTargetIndex(0, 1, 4, 3)).toBe(0);
  });
});
