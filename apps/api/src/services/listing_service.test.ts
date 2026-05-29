/**
 * Listing approval tests.
 *  - approvedStatus(): pure mapping, always runs.
 *  - approve/reject/guard: integration (RUN_INTEGRATION + DB).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { tenants, users, venues } from '../db/schema/index.js';
import { approveListing, approvedStatus, listListingsForReview, rejectListing } from './listing_service.js';

describe('approvedStatus', () => {
  it('maps each listing type to its live status', () => {
    expect(approvedStatus('venue')).toBe('active');
    expect(approvedStatus('arena')).toBe('active');
    expect(approvedStatus('membership')).toBe('active');
    expect(approvedStatus('event')).toBe('published');
  });
});

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('listing approval — integration', () => {
  let tenantId: string;
  let actorUserId: string;

  beforeAll(async () => {
    await pingDb();
    const [u] = await db
      .insert(users)
      .values({ firebaseUid: `listingsvc-${Date.now()}`, email: `listing-${Date.now()}@test.x` })
      .returning();
    actorUserId = u!.id;
    const [t] = await db
      .insert(tenants)
      .values({ name: 'ListingSvc', slug: `listingsvc-${Date.now()}` })
      .returning();
    tenantId = t!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from audit_log where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await db.execute(sql`delete from users where id = ${actorUserId}`);
    await closeDb();
  });

  async function newVenue(name: string): Promise<string> {
    const [v] = await db.insert(venues).values({ tenantId, name }).returning();
    return v!.id;
  }

  it('new venues default to pending_review and surface in the review queue', async () => {
    const id = await newVenue('Queue Venue');
    const queue = await listListingsForReview({ type: 'venue' });
    expect(queue.find((q) => q.id === id)?.status).toBe('pending_review');
    expect(queue.find((q) => q.id === id)?.tenantName).toBe('ListingSvc');
  });

  it('approveListing moves pending_review → active', async () => {
    const id = await newVenue('Approve Me');
    const res = await approveListing({ type: 'venue', id, actorUserId });
    expect(res.status).toBe('active');
  });

  it('rejectListing moves pending_review → rejected', async () => {
    const id = await newVenue('Reject Me');
    const res = await rejectListing({ type: 'venue', id, actorUserId, reason: 'incomplete photos' });
    expect(res.status).toBe('rejected');
  });

  it('cannot approve a listing that is not pending_review', async () => {
    const id = await newVenue('Double Approve');
    await approveListing({ type: 'venue', id, actorUserId });
    await expect(
      approveListing({ type: 'venue', id, actorUserId }),
    ).rejects.toMatchObject({ code: 'listing_not_pending' });
  });
});
