import { describe, expect, it } from 'vitest';
import { termsCountryFor } from './constants';

describe('termsCountryFor', () => {
  it("picks the org's own document from its country on file", () => {
    // The profile's country is free text; US spellings get the US document.
    for (const c of ['USA', 'US', 'united states', ' United States of America ']) {
      expect(termsCountryFor(c)).toBe('USA');
    }
    expect(termsCountryFor('India')).toBe('India');
    // Anywhere else signs the India document, as on the server.
    expect(termsCountryFor('Nepal')).toBe('India');
  });

  it('leaves the choice to the user when the org has no country on file', () => {
    expect(termsCountryFor(null)).toBeNull();
    expect(termsCountryFor(undefined)).toBeNull();
    expect(termsCountryFor('  ')).toBeNull();
  });
});
