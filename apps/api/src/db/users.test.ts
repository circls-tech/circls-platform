import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, pingDb } from './client.js';
import { users } from './schema/index.js';

// Integration test — opt in with RUN_INTEGRATION=1 and a real DATABASE_URL
// (local PG / CI). Verifies the migration applied, the UUIDv7 default fires,
// and the row round-trips.
const runIntegration = Boolean(process.env.RUN_INTEGRATION);

describe.skipIf(!runIntegration)('db: users table', () => {
  beforeAll(async () => {
    await pingDb();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('inserts a user with a server-generated UUIDv7 id and round-trips it', async () => {
    const stamp = Date.now();
    const inserted = await db
      .insert(users)
      .values({ firebaseUid: `test_${stamp}`, email: `t${stamp}@example.com` })
      .returning();

    const user = inserted[0];
    expect(user).toBeDefined();
    // UUID layout xxxxxxxx-xxxx-Vxxx-... → char at index 14 is the version nibble.
    expect(user!.id[14]).toBe('7');
    expect(user!.status).toBe('active'); // enum default

    const found = await db.query.users.findFirst({ where: eq(users.id, user!.id) });
    expect(found?.firebaseUid).toBe(`test_${stamp}`);
  });
});
