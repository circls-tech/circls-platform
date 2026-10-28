import { describe, expect, it } from 'vitest';
import { railEdges, railPageStep } from './rail';

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

describe('railPageStep', () => {
  it('moves by every card in full view on a laptop', () => {
    // The 1120px desktop column holds four 265px cards and their 20px gaps.
    expect(railPageStep(1120, 265, 20)).toBe(4 * 285);
  });

  it('moves past a card that only peeks in', () => {
    // A 736px tablet column shows two 260px cards and part of a third.
    expect(railPageStep(736, 260, 16)).toBe(2 * 276);
  });

  it('counts a card that ends exactly at the edge, without its trailing gap', () => {
    expect(railPageStep(4 * 276 - 16, 260, 16)).toBe(4 * 276);
  });

  it('moves at least one card when not even one fits', () => {
    expect(railPageStep(200, 260, 16)).toBe(276);
  });

  it('falls back to the visible width when cards have no size', () => {
    expect(railPageStep(800, 0, 0)).toBe(800);
  });
});
