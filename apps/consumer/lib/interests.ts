/**
 * Interest categories a consumer can pick on their profile page. Slugs are the
 * canonical values stored by the API — mirror of apps/api/src/lib/interests.ts
 * (keep the two in sync).
 */
export interface InterestCategory {
  slug: string;
  label: string;
  emoji: string;
}

export const INTEREST_CATEGORIES: readonly InterestCategory[] = [
  { slug: 'sports', label: 'Sports & Fitness', emoji: '🏸' },
  { slug: 'dance', label: 'Dance', emoji: '💃' },
  { slug: 'music', label: 'Music', emoji: '🎵' },
  { slug: 'arts', label: 'Arts & Crafts', emoji: '🎨' },
  { slug: 'learning', label: 'Learning & Workshops', emoji: '📚' },
  { slug: 'gaming', label: 'Gaming & Esports', emoji: '🎮' },
  { slug: 'outdoors', label: 'Outdoors & Adventure', emoji: '🏕️' },
  { slug: 'wellness', label: 'Wellness & Yoga', emoji: '🧘' },
  { slug: 'food', label: 'Food & Drink', emoji: '🍜' },
  { slug: 'social', label: 'Social & Community', emoji: '🤝' },
  { slug: 'tech', label: 'Tech & Startups', emoji: '💻' },
  { slug: 'family', label: 'Family & Kids', emoji: '🧒' },
] as const;
