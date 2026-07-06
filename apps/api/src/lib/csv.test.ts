import { describe, expect, it } from 'vitest';
import { csvDocument, csvField } from './csv.js';

describe('csvField', () => {
  it('quotes plain values', () => {
    expect(csvField('hello')).toBe('"hello"');
    expect(csvField(42)).toBe('"42"');
  });

  it('renders null/undefined as an empty quoted field', () => {
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
  });

  it('doubles internal quotes', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('keeps commas and newlines inside the quoted field', () => {
    expect(csvField('a,b\nc')).toBe('"a,b\nc"');
  });
});

describe('csvDocument', () => {
  it('starts with a UTF-8 BOM and joins rows with CRLF', () => {
    const doc = csvDocument(['A', 'B'], [['1', '2'], ['3', null]]);
    expect(doc.charCodeAt(0)).toBe(0xfeff);
    expect(doc.slice(1)).toBe('"A","B"\r\n"1","2"\r\n"3",""');
  });

  it('handles zero data rows', () => {
    const doc = csvDocument(['Only', 'Headers'], []);
    expect(doc.slice(1)).toBe('"Only","Headers"');
  });
});
