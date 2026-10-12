/**
 * Listing preview tokens.
 *  - mint / verify / previewAllows: pure, always run.
 *  - the public reads honouring a token: integration (RUN_INTEGRATION + DB).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from '../db/client.js';
import { arenas, events, memberships, tenants, venues } from '../db/schema/index.js';
import {
  createListingPreview,
  mintPreviewToken,
  previewAllows,
  PREVIEW_TTL_SEC,
  verifyPreviewToken,
} from './listing_preview_service.js';
import {
  getPublicEventById,
  getPublicMembershipById,
  getPublicVenueWithImages,
  listPublicArenas,
  listPublicArenaSlots,
  listPublicEvents,
} from './consumer_service.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

describe('preview tokens', () => {
  it('round-trips the listing it was minted for', () => {
    const { token, expiresAt } = mintPreviewToken({ type: 'event', id: EVENT_ID });
    const claims = verifyPreviewToken(token);
    expect(claims).toMatchObject({ type: 'event', id: EVENT_ID });
    expect(claims!.exp * 1000).toBe(expiresAt.getTime());
    // Default lifetime: an hour, give or take the second it took to mint.
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan((PREVIEW_TTL_SEC - 5) * 1000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(PREVIEW_TTL_SEC * 1000);
  });

  it('is good for exactly one listing', () => {
    const { token } = mintPreviewToken({ type: 'event', id: EVENT_ID });
    expect(previewAllows(token, { type: 'event', id: EVENT_ID })).toBe(true);
    // Another id of the same type, and the same id as another type: both refused.
    expect(previewAllows(token, { type: 'event', id: OTHER_ID })).toBe(false);
    expect(previewAllows(token, { type: 'venue', id: EVENT_ID })).toBe(false);
  });

  it('expires', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    const { token } = mintPreviewToken({ type: 'venue', id: EVENT_ID }, { now, ttlSec: 60 });
    expect(verifyPreviewToken(token, new Date(now.getTime() + 59_000))).not.toBeNull();
    expect(verifyPreviewToken(token, new Date(now.getTime() + 60_000))).toBeNull();
  });

  it('refuses anything tampered with or made up', () => {
    const { token } = mintPreviewToken({ type: 'membership', id: EVENT_ID });
    const [payload, sig] = token.split('.') as [string, string];

    // Swap the id inside the payload, keep the signature.
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), id: OTHER_ID }),
    ).toString('base64url');
    expect(verifyPreviewToken(`${forged}.${sig}`)).toBeNull();

    // Damage the signature.
    expect(verifyPreviewToken(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    // Not even the right shape.
    expect(verifyPreviewToken('')).toBeNull();
    expect(verifyPreviewToken('nope')).toBeNull();
    expect(verifyPreviewToken(`${payload}.`)).toBeNull();
    expect(previewAllows(undefined, { type: 'membership', id: EVENT_ID })).toBe(false);
    expect(previewAllows(42, { type: 'membership', id: EVENT_ID })).toBe(false);
  });

  it('builds the consumer-site URL for the listing with the token on it', () => {
    const p = createListingPreview({ type: 'membership', id: EVENT_ID });
    const url = new URL(p.url);
    expect(url.pathname).toBe(`/memberships/${EVENT_ID}`);
    expect(previewAllows(url.searchParams.get('preview'), { type: 'membership', id: EVENT_ID })).toBe(
      true,
    );
    expect(new Date(p.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new URL(createListingPreview({ type: 'event', id: EVENT_ID }).url).pathname).toBe(
      `/events/${EVENT_ID}`,
    );
    expect(new URL(createListingPreview({ type: 'venue', id: EVENT_ID }).url).pathname).toBe(
      `/venues/${EVENT_ID}`,
    );
  });
});

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('public reads under a preview token — integration', () => {
  let tenantId: string;
  let venueId: string; // pending_review
  let arenaId: string; // pending_review, inside the pending venue
  let draftEventId: string; // draft, standalone
  let venueEventId: string; // published, but at the pending venue
  let pendingMembershipId: string;

  beforeAll(async () => {
    await pingDb();
    const [t] = await db
      .insert(tenants)
      .values({ name: 'PreviewOrg', slug: `previeworg-${Date.now()}`, status: 'active' })
      .returning();
    tenantId = t!.id;
    const [v] = await db
      .insert(venues)
      .values({ tenantId, name: 'Pending Venue', tzName: 'Asia/Kolkata', status: 'pending_review' })
      .returning();
    venueId = v!.id;
    const [a] = await db
      .insert(arenas)
      .values({ venueId, name: 'Pending Court', status: 'pending_review' })
      .returning();
    arenaId = a!.id;
    const [e] = await db
      .insert(events)
      .values({
        tenantId,
        venueId: null,
        addressJson: { line1: '1 Draft Rd', city: 'Pune' },
        tzName: 'Asia/Kolkata',
        name: 'Draft Event',
        startsAt: new Date('2031-01-01T10:00:00Z'),
        endsAt: new Date('2031-01-01T12:00:00Z'),
        pricePaise: 0,
        status: 'draft',
      })
      .returning();
    draftEventId = e!.id;
    const [ve] = await db
      .insert(events)
      .values({
        tenantId,
        venueId,
        name: 'Event at pending venue',
        startsAt: new Date('2031-01-02T10:00:00Z'),
        endsAt: new Date('2031-01-02T12:00:00Z'),
        pricePaise: 0,
        status: 'published',
      })
      .returning();
    venueEventId = ve!.id;
    const [m] = await db
      .insert(memberships)
      .values({ tenantId, venueId: null, name: 'Pending Plan', durationDays: 30, status: 'pending_review' })
      .returning();
    pendingMembershipId = m!.id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from memberships where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from events where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from arenas where venue_id = ${venueId}`);
    await db.execute(sql`delete from venues where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('shows a draft event only to its preview token', async () => {
    expect(await getPublicEventById(draftEventId)).toBeNull();
    expect(await getPublicEventById(draftEventId, { previewToken: 'garbage' })).toBeNull();
    const { token } = mintPreviewToken({ type: 'event', id: draftEventId });
    const ev = await getPublicEventById(draftEventId, { previewToken: token });
    expect(ev).toMatchObject({ id: draftEventId, name: 'Draft Event', isStandalone: true });
    // The same token opens nothing else.
    expect(await getPublicEventById(venueEventId, { previewToken: token })).toBeNull();
  });

  it('shows a pending membership only to its preview token', async () => {
    expect(await getPublicMembershipById(pendingMembershipId)).toBeNull();
    const { token } = mintPreviewToken({ type: 'membership', id: pendingMembershipId });
    const m = await getPublicMembershipById(pendingMembershipId, { previewToken: token });
    expect(m).toMatchObject({ id: pendingMembershipId, name: 'Pending Plan' });
  });

  it('shows a pending venue, its pending arenas and their slots, to its preview token', async () => {
    expect(await getPublicVenueWithImages(venueId)).toBeNull();
    await expect(listPublicArenas(venueId)).rejects.toMatchObject({ code: 'venue_not_found' });

    const { token } = mintPreviewToken({ type: 'venue', id: venueId });
    const opts = { previewToken: token };
    expect(await getPublicVenueWithImages(venueId, opts)).toMatchObject({ id: venueId });
    expect((await listPublicArenas(venueId, opts)).map((a) => a.id)).toEqual([arenaId]);
    // The pending arena's slot list opens too (empty — nothing released).
    expect(
      await listPublicArenaSlots(arenaId, '2031-01-01T00:00:00.000Z', '2031-01-02T00:00:00.000Z', opts),
    ).toEqual([]);
    await expect(
      listPublicArenaSlots(arenaId, '2031-01-01T00:00:00.000Z', '2031-01-02T00:00:00.000Z'),
    ).rejects.toMatchObject({ code: 'arena_not_found' });
    // The venue's event list opens with the venue — still published events only.
    expect((await listPublicEvents(venueId, opts)).map((e) => e.id)).toEqual([venueEventId]);
  });

  it('does not let a venue preview open the venue’s events on their own page', async () => {
    // The event page has its own token type; the venue's doesn't name it.
    const { token } = mintPreviewToken({ type: 'venue', id: venueId });
    expect(await getPublicEventById(venueEventId, { previewToken: token })).toBeNull();
  });
});
