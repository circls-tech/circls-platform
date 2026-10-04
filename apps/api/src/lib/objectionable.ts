import { BadRequest } from './errors.js';

/**
 * A word-list check on what consumers post where other people read it —
 * question threads and the display name shown on them (App Store guideline
 * 1.2: "a method for filtering objectionable material from being posted").
 * Deliberately small and whole-word: it stops obvious profanity and slurs at
 * the door; anything subtler is what Report, Block and staff moderation
 * (hide/archive) are for.
 *
 * Case-insensitive, NFKC-folded (fullwidth letters), sees through simple
 * leetspeak and masking ("sh1t", "sh!t", "f*ck"), and only ever matches a
 * whole token — never inside a longer word ("Scunthorpe", "cocktail") or an
 * alphanumeric code ("F4G6"). Words that are also ordinary words or names in
 * the places Circls runs (randi, lund, lauda, prick) are left out.
 */
const WORDS = new Set([
  // English
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin', 'fck', 'fuk', 'fking',
  'fuckoff', 'fuckyou', 'motherfucker', 'motherfucking', 'shit', 'shits', 'shitty', 'shithole',
  'shithead', 'bullshit', 'bitch', 'bitches', 'bastard', 'cunt', 'cunts', 'dickhead', 'asshole',
  'assholes', 'slut', 'sluts', 'whore', 'whores', 'fag', 'fags', 'faggot', 'faggots', 'nigger',
  'niggers', 'nigga', 'niggas', 'retard', 'retards', 'wanker', 'twat', 'pussy',
  // Hindi / Hinglish
  'madarchod', 'maderchod', 'behenchod', 'bhenchod', 'behanchod', 'bahenchod', 'benchod', 'bsdk',
  'bhosdike', 'bhosadike', 'bhosdi', 'bhosdiwale', 'chutiya', 'chutiye', 'chutia', 'chootiya',
  'gandu', 'gaand', 'lawda', 'loda', 'lodu', 'lavde', 'harami',
]);

const LEET: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i',
};

export function containsObjectionable(text: string): boolean {
  const tokens = text.normalize('NFKC').toLowerCase().match(/[a-z0-9@$!*_]+/g) ?? [];
  return tokens.some((token) =>
    WORDS.has(
      token
        .replace(/^[!*_]+|[!*_]+$/g, '') // "shit!!", "*fuck*"
        .replace(/[013457@$!]/g, (c) => LEET[c] ?? c)
        .replace(/[*_]/g, ''), // "f*ck"
    ),
  );
}

/** 400 `objectionable_content` for text [containsObjectionable] flags. */
export function assertNotObjectionable(text: string): void {
  if (containsObjectionable(text)) {
    throw new BadRequest(
      'Please keep it respectful. That message has language we don’t allow.',
      'objectionable_content',
    );
  }
}
