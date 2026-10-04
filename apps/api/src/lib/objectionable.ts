import { BadRequest } from './errors.js';

/**
 * A word-list check on what consumers post to question threads (App Store
 * guideline 1.2: "a method for filtering objectionable material from being
 * posted"). Deliberately small and whole-word: it stops obvious profanity and
 * slurs at the door; anything subtler is what Report, Block and staff
 * moderation (hide/archive) are for.
 *
 * Case-insensitive, sees through simple leetspeak and masking ("sh1t",
 * "f*ck"), and never fires inside a longer word ("Scunthorpe", "cocktail").
 */
const WORDS = new Set([
  // English
  'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking', 'fuckin', 'fck', 'fuk', 'fking',
  'motherfucker', 'shit', 'shits', 'shitty', 'bullshit', 'bitch', 'bitches', 'bastard',
  'cunt', 'cunts', 'dickhead', 'asshole', 'assholes', 'slut', 'sluts', 'whore', 'whores',
  'fag', 'fags', 'faggot', 'faggots', 'nigger', 'niggers', 'nigga', 'niggas', 'retard',
  'retards', 'wanker', 'twat', 'prick', 'pussy',
  // Hindi / Hinglish
  'madarchod', 'maderchod', 'behenchod', 'bhenchod', 'behanchod', 'bhosdike', 'bhosdi',
  'bhosdiwale', 'chutiya', 'chutiye', 'chutia', 'gandu', 'randi', 'lund', 'lauda', 'laude',
  'lavde', 'harami',
]);

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

export function containsObjectionable(text: string): boolean {
  const normalised = text
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => LEET[c] ?? c)
    // Masking inside a word ("f*ck", "f.u.c.k" stays split — that's fine).
    .replace(/(?<=[a-z])[*_]+(?=[a-z])/g, '');
  return (normalised.match(/[a-z]+/g) ?? []).some((w) => WORDS.has(w));
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
