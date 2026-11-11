import { describe, expect, it } from 'vitest';
import type { AddressSuggestion } from '@/lib/api/geocode';
import { addressFromSuggestion, applyAddressSuggestion } from './address_suggestion';

const NOW = new Date('2026-11-11T10:00:00.000Z');

/** A resolved Google street pick: no postal code, as street results often have none. */
const STREET: AddressSuggestion = {
  label: '100 Feet Road, Indiranagar, Bengaluru, Karnataka, India',
  placeId: 'Ek8xMDAgRmVldCBSb2Fk',
  line1: '100 Feet Road, Stage 3, Indiranagar',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: null,
  country: 'India',
  lat: 12.9746638,
  lng: 77.6410107,
};

describe('addressFromSuggestion', () => {
  it("empties a field the pick doesn't know rather than keeping the old address's", () => {
    const a = addressFromSuggestion(STREET, NOW);
    expect(a.postalCode).toBe('');
    expect(a.line1).toBe('100 Feet Road, Stage 3, Indiranagar');
  });

  it("records a Google pick's place and when it was fetched", () => {
    expect(addressFromSuggestion(STREET, NOW).coords).toEqual({
      lat: 12.9746638,
      lng: 77.6410107,
      placeId: 'Ek8xMDAgRmVldCBSb2Fk',
      fetchedAt: '2026-11-11T10:00:00.000Z',
    });
  });

  it('gives a free-provider pick no place and no fetch time', () => {
    const a = addressFromSuggestion({ ...STREET, placeId: null }, NOW);
    expect(a.coords).toMatchObject({ placeId: null, fetchedAt: null });
  });

  it('leaves the country alone when the pick names none we serve, and clears a pin it has no coordinates for', () => {
    const a = addressFromSuggestion({ ...STREET, country: null, lat: null, lng: null }, NOW);
    expect(a.country).toBeNull();
    expect(a.coords).toBeNull();
  });
});

describe('applyAddressSuggestion', () => {
  it('writes every field, so nothing from the previous address survives', () => {
    const form: Record<string, unknown> = { postalCode: '560034', country: 'India' };
    applyAddressSuggestion(STREET, {
      setLine1: (v) => (form.line1 = v),
      setCity: (v) => (form.city = v),
      setState: (v) => (form.state = v),
      setPostalCode: (v) => (form.postalCode = v),
      setCountry: (v) => (form.country = v),
      setCoords: (c) => (form.coords = c),
    });
    expect(form).toMatchObject({ line1: '100 Feet Road, Stage 3, Indiranagar', city: 'Bengaluru', postalCode: '' });
    expect((form.coords as { placeId: string }).placeId).toBe('Ek8xMDAgRmVldCBSb2Fk');
  });
});
