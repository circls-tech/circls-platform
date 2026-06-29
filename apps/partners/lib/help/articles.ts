// ── Help Centre article manifest ───────────────────────────────────────────────
//
// Single source of truth for the Help Centre article list. Each entry's `slug`
// must have a matching markdown file at `content/help/<slug>.md`.
//
// MAINTENANCE: when product behaviour changes, update both this manifest (if the
// title/summary/category shifts) and the corresponding markdown body. See
// content/help/README.md for the article → code-area map.

export interface HelpArticleMeta {
  /** URL slug and markdown filename (content/help/<slug>.md). */
  slug: string;
  title: string;
  category: string;
  /** One-line summary shown on the list and quick-access cards. */
  summary: string;
  /** Show this article in the "Quick access" row at the top of the Help Centre. */
  quickLink?: boolean;
  /** Sort order within the full list (ascending). */
  order: number;
}

export const HELP_ARTICLES: HelpArticleMeta[] = [
  {
    slug: 'onboarding',
    title: 'Getting started: create your organisation and first venue',
    category: 'Setup',
    summary:
      'A step-by-step walkthrough of the onboarding wizard — creating an organisation, adding a venue, setting up arenas, and releasing your first slots.',
    quickLink: true,
    order: 1,
  },
  {
    slug: 'venues',
    title: 'Managing venues and arenas',
    category: 'Venues',
    summary:
      'How to add, edit and update your venues and arenas, upload photos, and manage their listing status.',
    order: 2,
  },
  {
    slug: 'schedule',
    title: 'Setting up schedules and slot pricing',
    category: 'Scheduling',
    summary:
      'Use the schedule builder to set pricing bands (including overnight and 24-hour windows), a business-day start, slot durations, and per-slot pricing on a visual grid.',
    quickLink: true,
    order: 3,
  },
  {
    slug: 'bookings',
    title: 'Understanding bookings and cancellations',
    category: 'Bookings',
    summary:
      'How to view confirmed bookings, handle cancellations, issue refunds, and manage no-shows.',
    quickLink: true,
    order: 4,
  },
  {
    slug: 'events',
    title: 'Creating and publishing events',
    category: 'Events',
    summary:
      'How to create events, define ticket tiers (name, price, capacity), and get them approved for the consumer portal.',
    order: 5,
  },
  {
    slug: 'memberships',
    title: 'Setting up membership plans',
    category: 'Memberships',
    summary:
      'How to create membership plans, define benefits and pricing, and manage active member subscriptions.',
    order: 6,
  },
  {
    slug: 'organisation',
    title: 'Managing your organisation profile',
    category: 'Settings',
    summary:
      'Edit your organisation’s brand profile — logo, description, contact details, website, socials and address — that customers see across Circls.',
    order: 7,
  },
  {
    slug: 'team',
    title: 'Inviting and managing team members',
    category: 'Settings',
    summary:
      'How to invite colleagues to your organisation, assign roles (owner, manager, staff, read-only), and revoke access.',
    order: 8,
  },
  {
    slug: 'api-keys',
    title: 'API keys and webhooks',
    category: 'Developer',
    summary:
      'How to generate API keys, configure outbound webhooks, and integrate circls with your own systems.',
    order: 9,
  },
  {
    slug: 'coupons',
    title: 'Creating and managing discount coupons',
    category: 'Discounts',
    summary:
      'Create percentage or fixed-amount discount codes, scope them to your org / a venue / a specific event, arena or membership, set validity and redemption limits, and choose whether they are public or private.',
    order: 10,
  },
];

export function getArticleMeta(slug: string): HelpArticleMeta | undefined {
  return HELP_ARTICLES.find((a) => a.slug === slug);
}

export const HELP_SLUGS = HELP_ARTICLES.map((a) => a.slug);
