import { describe, expect, it } from 'vitest';
import { benefitsSchema, coerceBenefits } from './membership_benefits.js';

describe('coerceBenefits (PR #110 legacy coercion)', () => {
  it('keeps an already-typed blob', () => {
    const input = { items: [{ label: 'Free coffee', detail: 'one per visit' }, { label: 'Priority booking' }] };
    expect(coerceBenefits(input)).toEqual(input);
  });

  it('drops malformed items inside a typed blob', () => {
    const input = { items: [{ label: 'ok' }, { label: '' }, { detail: 'no label' }, 42] };
    expect(coerceBenefits(input)).toEqual({ items: [{ label: 'ok' }] });
  });

  it('coerces a string[] into labelled items', () => {
    expect(coerceBenefits(['Sauna', '10% off rentals'])).toEqual({
      items: [{ label: 'Sauna' }, { label: '10% off rentals' }],
    });
  });

  it('coerces an object[] (preserving label/detail) ', () => {
    expect(coerceBenefits([{ label: 'A', detail: 'x' }, 'B'])).toEqual({
      items: [{ label: 'A', detail: 'x' }, { label: 'B' }],
    });
  });

  it('coerces a flat key/value object into label/detail pairs', () => {
    expect(coerceBenefits({ Parking: 'free', Lounge: 'members only' })).toEqual({
      items: [
        { label: 'Parking', detail: 'free' },
        { label: 'Lounge', detail: 'members only' },
      ],
    });
  });

  it('is safe for empty / null / primitive inputs', () => {
    expect(coerceBenefits({})).toEqual({ items: [] });
    expect(coerceBenefits(null)).toEqual({ items: [] });
    expect(coerceBenefits(undefined)).toEqual({ items: [] });
    expect(coerceBenefits('garbage')).toEqual({ items: [] });
  });
});

describe('benefitsSchema (write validation)', () => {
  it('accepts a valid typed payload', () => {
    expect(benefitsSchema.safeParse({ items: [{ label: 'X' }] }).success).toBe(true);
  });

  it('rejects items without a label', () => {
    expect(benefitsSchema.safeParse({ items: [{ detail: 'no label' }] }).success).toBe(false);
  });

  it('rejects an empty label', () => {
    expect(benefitsSchema.safeParse({ items: [{ label: '' }] }).success).toBe(false);
  });

  it('rejects a non-array items field', () => {
    expect(benefitsSchema.safeParse({ items: 'nope' }).success).toBe(false);
  });
});
