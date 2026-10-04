import { describe, expect, it } from 'vitest';
import { containsObjectionable } from './objectionable.js';

describe('containsObjectionable', () => {
  it.each([
    'what the fuck is this',
    'F*CK this venue',
    'total sh1t service',
    'Bullshit!',
    'tu chutiya hai',
    'BEHENCHOD',
  ])('flags %j', (text) => {
    expect(containsObjectionable(text)).toBe(true);
  });

  it.each([
    'Is there parking at the venue?',
    'Scunthorpe classic assassin',
    'Cocktails after the match?',
    'Can I pass the ball to Dick?',
    'Shuttle 3 at 5pm, 4 players',
    '',
  ])('lets %j through', (text) => {
    expect(containsObjectionable(text)).toBe(false);
  });
});
