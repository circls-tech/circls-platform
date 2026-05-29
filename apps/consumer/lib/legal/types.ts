export interface LegalSection {
  /** Optional group divider shown before this section, e.g. "Your Rights". */
  group?: string;
  number?: number;
  title: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDoc {
  slug: 'privacy' | 'terms' | 'refund';
  title: string;
  updated: string; // "12 May 2026"
  intro: string;
  sections: LegalSection[];
}
