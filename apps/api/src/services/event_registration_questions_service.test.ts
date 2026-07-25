import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

const runIntegration = Boolean(process.env.RUN_INTEGRATION);

// Dynamic imports AFTER vi.mock (none here), gated so non-integration runs skip
// the real DB import entirely.
const { closeDb, db } = await import('../db/client.js');
const { listQuestions, replaceQuestions, saveRegistrationAnswers } = await import(
  './event_registration_questions_service.js'
);

describe.skipIf(!runIntegration)('event_registration_questions_service', () => {
  let tenantId: string;
  let eventId: string;
  let bookingId: string;

  beforeAll(async () => {
    const t = await db.execute<{ id: string }>(
      sql`insert into tenants (name, slug, status) values ('QuestionSvc', ${'questionsvc-' + Date.now()}, 'active') returning id`,
    );
    tenantId = ((t as unknown as { id: string }[])[0]!).id;
    const e = await db.execute<{ id: string }>(
      sql`insert into events (tenant_id, name, starts_at, ends_at, price_paise, status, address_json, tz_name)
          values (${tenantId}, 'E', now() + interval '1 day', now() + interval '2 day', 0, 'draft', '{"city":"Pune"}', 'Asia/Kolkata') returning id`,
    );
    eventId = ((e as unknown as { id: string }[])[0]!).id;
    const b = await db.execute<{ id: string }>(
      sql`insert into bookings (tenant_id, item_type, channel, payment_method, status, item_data)
          values (${tenantId}, 'event', 'circls', 'free', 'confirmed', ${JSON.stringify({ eventId })}::jsonb) returning id`,
    );
    bookingId = ((b as unknown as { id: string }[])[0]!).id;
  });

  afterAll(async () => {
    await db.execute(sql`delete from event_registration_answers where booking_id = ${bookingId}`);
    await db.execute(sql`delete from event_registration_questions where event_id = ${eventId}`);
    await db.execute(sql`delete from bookings where id = ${bookingId}`);
    await db.execute(sql`delete from events where id = ${eventId}`);
    await db.execute(sql`delete from tenants where id = ${tenantId}`);
    await closeDb();
  });

  it('replaceQuestions inserts questions in order and an empty set clears them', async () => {
    const inserted = await db.transaction((tx) =>
      replaceQuestions(tx, eventId, tenantId, [
        { label: 'T-shirt size?', type: 'select', required: true, options: ['S', 'M', 'L'] },
        { label: 'Dietary restrictions?', type: 'text', required: false },
      ]),
    );
    expect(inserted).toHaveLength(2);
    const live = await listQuestions(db, eventId);
    expect(live.map((q) => q.label)).toEqual(['T-shirt size?', 'Dietary restrictions?']);
    expect(live[0]!.options).toEqual(['S', 'M', 'L']);
    expect(live[1]!.options).toBeNull();

    await db.transaction((tx) => replaceQuestions(tx, eventId, tenantId, []));
    expect(await listQuestions(db, eventId)).toHaveLength(0);
  });

  it('saveRegistrationAnswers stores valid answers with label snapshots', async () => {
    await db.transaction((tx) =>
      replaceQuestions(tx, eventId, tenantId, [
        { label: 'T-shirt size?', type: 'select', required: true, options: ['S', 'M', 'L'] },
        { label: 'Anything else?', type: 'text', required: false },
      ]),
    );
    const questions = await listQuestions(db, eventId);
    await db.transaction((tx) =>
      saveRegistrationAnswers(tx, eventId, bookingId, [
        { questionId: questions[0]!.id, answer: 'M' },
      ]),
    );
    const rows = await db.execute<{ question_label: string; answer: string }>(
      sql`select question_label, answer from event_registration_answers where booking_id = ${bookingId}`,
    );
    const arr = rows as unknown as { question_label: string; answer: string }[];
    expect(arr).toHaveLength(1);
    expect(arr[0]).toMatchObject({ question_label: 'T-shirt size?', answer: 'M' });
  });

  it('rejects a missing required answer, a bad option, and an unknown question', async () => {
    const questions = await listQuestions(db, eventId);
    const required = questions.find((q) => q.required)!;
    await expect(
      db.transaction((tx) => saveRegistrationAnswers(tx, eventId, bookingId, [])),
    ).rejects.toThrow(/requires an answer/);
    await expect(
      db.transaction((tx) =>
        saveRegistrationAnswers(tx, eventId, bookingId, [
          { questionId: required.id, answer: 'XXL' },
        ]),
      ),
    ).rejects.toThrow(/must be one of its options/);
    await expect(
      db.transaction((tx) =>
        saveRegistrationAnswers(tx, eventId, bookingId, [
          { questionId: required.id, answer: 'M' },
          { questionId: '00000000-0000-7000-8000-000000000000', answer: 'x' },
        ]),
      ),
    ).rejects.toThrow(/Unknown registration question/);
  });
});
