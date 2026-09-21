import { describe, expect, it } from 'vitest';
import { stepIndex, swipeStep } from './carousel';

describe('stepIndex', () => {
  it('wraps forwards and backwards around the ring', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(1, 3, -1)).toBe(0);
  });

  it('is a no-op for a single slide and safe for none', () => {
    expect(stepIndex(0, 1, 1)).toBe(0);
    expect(stepIndex(0, 1, -1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(0);
  });
});

describe('swipeStep', () => {
  it('treats short drags as taps', () => {
    expect(swipeStep(0, 40)).toBe(0);
    expect(swipeStep(39, 40)).toBe(0);
    expect(swipeStep(-39, 40)).toBe(0);
  });

  it('moves to the next slide on a leftward drag and back on a rightward one', () => {
    expect(swipeStep(-40, 40)).toBe(1);
    expect(swipeStep(-200, 40)).toBe(1);
    expect(swipeStep(40, 40)).toBe(-1);
    expect(swipeStep(120, 40)).toBe(-1);
  });
});
