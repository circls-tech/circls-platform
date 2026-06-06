import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Firebase verifier mock. Distinct tokens model verified vs unverified email
// ownership so the C1 account-takeover guards can be exercised end to end.
vi.mock('../lib/firebase_admin.js', () => ({
  verifyIdToken: vi.fn(async (token: string) => {
    const map: Record<string, Record<string, unknown>> = {
      // Legitimate tenant owner (verified) who sends the invite.
      owner: { uid: 'fbuid_inv_owner', email: 'inv_owner@x.com', email_verified: true },
      // Victim: a real user whose verified email is the takeover target.
      victim: { uid: 'fbuid_inv_victim', email: 'victim@x.com', email_verified: true },
      // Attacker: a NEW uid presenting the victim's email but UNVERIFIED.
      attacker: { uid: 'fbuid_inv_attacker', email: 'victim@x.com', email_verified: false },
      // Invitee accepting with an UNVERIFIED email claim.
      unverifiedInvitee: {
        uid: 'fbuid_inv_unverified',
        email: 'invitee@x.com',
        email_verified: false,
      },
    };
    const u = map[token];
    if (!u) throw new Error('bad token');
    return u;
  }),
}));

const { closeDb, db } = await import('../db/client.js');
const { buildServer } = await import('../server.js');

const runIntegration = Boolean(process.env.RUN_INTEGRATION);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe.skipIf(!runIntegration)('invitations + C1 unverified-email guards', () => {
  let app: FastifyInstance;
  let ownerUserId: string;
  let tenantId: string;
  const SUFFIX = Date.now();
  const slug = `inv-acme-${SUFFIX}`;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();

    // Provision the owner row + a tenant they own.
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('owner') });
    expect(me.statusCode).toBe(200);
    ownerUserId = (me.json() as { id: string }).id;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: bearer('owner'),
      payload: { name: 'Invite Acme', slug },
    });
    expect(created.statusCode).toBe(200);
    tenantId = (created.json() as { id: string }).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.execute(sql`DELETE FROM tenant_invitations WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenant_members WHERE tenant_id = ${tenantId}::uuid`);
      // The accept flow writes a membership notification that FK-references the tenant;
      // delete it before the tenant or the cleanup trips notifications_tenant_id_tenants_id_fk.
      await db.execute(sql`DELETE FROM notifications WHERE tenant_id = ${tenantId}::uuid`);
      await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`);
    }
    await db.execute(sql`DELETE FROM users WHERE firebase_uid IN
      ('fbuid_inv_owner','fbuid_inv_victim','fbuid_inv_attacker','fbuid_inv_unverified')`);
    await app.close();
    await closeDb();
  });

  it('rejects POST /v1/invitations/:token/accept with an unverified email (403 email_unverified)', async () => {
    // Create a real, live invitation for invitee@x.com and grab the plaintext token.
    const inv = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/invitations`,
      headers: bearer('owner'),
      payload: { email: 'invitee@x.com', role: 'staff' },
    });
    expect(inv.statusCode).toBe(201);
    const inviteToken = (inv.json() as { token: string }).token;

    // Accept it with a token whose email_verified is false → must be rejected
    // BEFORE any adoption/membership write.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/invitations/${inviteToken}/accept`,
      payload: { firebaseIdToken: 'unverifiedInvitee' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('email_unverified');

    // The invitation must still be pending (not consumed by the rejected accept).
    const pending = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/invitations?status=pending`,
      headers: bearer('owner'),
    });
    expect(pending.statusCode).toBe(200);
    expect(
      (pending.json() as { email: string }[]).some((i) => i.email === 'invitee@x.com'),
    ).toBe(true);
  });

  it('closes the takeover: an unverified email on GET /v1/me does NOT adopt the victim row', async () => {
    // Victim signs in with a verified email → owns a row under fbuid_inv_victim.
    const victim = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('victim') });
    expect(victim.statusCode).toBe(200);
    const victimBody = victim.json() as { id: string; firebaseUid: string; email: string };
    expect(victimBody.firebaseUid).toBe('fbuid_inv_victim');
    expect(victimBody.email).toBe('victim@x.com');

    // Attacker presents a NEW uid carrying the victim's email, but UNVERIFIED.
    // requireAuth drops the email → adoptStaleIdentity has no email to match on,
    // so the attacker just gets their own fresh row; the victim row is untouched.
    const attacker = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer('attacker') });
    expect(attacker.statusCode).toBe(200);
    const attackerBody = attacker.json() as { id: string; firebaseUid: string; email: string | null };
    expect(attackerBody.firebaseUid).toBe('fbuid_inv_attacker');
    expect(attackerBody.id).not.toBe(victimBody.id);
    // Unverified email was dropped, so it never lands on the attacker's row.
    expect(attackerBody.email).toBeNull();

    // Decisive: the victim's row still belongs to the victim's original uid.
    const rows = await db.execute<{ firebase_uid: string }>(sql`
      SELECT firebase_uid FROM users WHERE id = ${victimBody.id}::uuid
    `);
    const stillVictim = (rows as unknown as { firebase_uid: string }[])[0];
    expect(stillVictim?.firebase_uid).toBe('fbuid_inv_victim');
  });
});
