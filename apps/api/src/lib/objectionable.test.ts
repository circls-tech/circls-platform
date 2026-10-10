import { describe, expect, it } from 'vitest';
import { containsObjectionable } from './objectionable.js';

describe('containsObjectionable', () => {
  it.each([
    'what the fuck is this',
    'F*CK this venue',
    'total sh1t service',
    'total sh!t service',
    'Bullshit!',
    'a$$hole organiser',
    'ｆｕｃｋ', // fullwidth
    'what a shithole',
    'tu chutiya hai',
    'BEHENCHOD',
    'bsdk',
  ])('flags %j', (text) => {
    expect(containsObjectionable(text)).toBe(true);
  });

  it.each([
    'Is there parking at the venue?',
    'Scunthorpe classic assassin',
    'Cocktails after the match?',
    'Can I pass the ball to Dick?',
    'Shuttle 3 at 5pm, 4 players',
    'Booking code F4G6 at the desk',
    'Randi, are you coming?',
    'Lund vs Pune, Niki Lauda, cum laude, a pin prick',
    'parking hai kya? kitne baje khulta hai',
    '',
  ])('lets %j through', (text) => {
    expect(containsObjectionable(text)).toBe(false);
  });
});
