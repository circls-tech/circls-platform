import { index, pgEnum, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/** What a consumer can save to their wishlist. */
export const wishlistItemType = pgEnum('wishlist_item_type', ['event', 'membership', 'venue']);
export type WishlistItemType = (typeof wishlistItemType.enumValues)[number];

/**
 * A consumer's "liked" listings — the wishlist behind the heart on event,
 * membership and venue cards (consumer web, `/me/wishlist`). Personal and
 * private: nobody but the owner reads it, and a like never surfaces to the
 * partner. One row per (user, item); liking twice is a no-op, unliking a row
 * that isn't there is too.
 *
 * `item_id` is deliberately not a foreign key: the three item types live in
 * three tables, and a listing that is later deleted or unpublished simply
 * drops out of the wishlist read (which re-applies the public visibility
 * rules) rather than erroring.
 */
export const wishlistItems = pgTable(
  'wishlist_items',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemType: wishlistItemType('item_type').notNull(),
    itemId: uuid('item_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.itemType, t.itemId] }),
    index('wishlist_items_user_created_idx').on(t.userId, t.createdAt),
  ],
);

export type WishlistItem = typeof wishlistItems.$inferSelect;
