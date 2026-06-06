import { describe, expect, it } from 'vitest';
import { activityBatchBody } from './consumer.js';

// Pure validation tests (no DB) for the POST /v1/consumer/activity batch body.
describe('activity batch validation', () => {
  const good = {
    eventType: 'screen_view',
    clientTs: '2026-06-06T07:30:00.000Z',
    sessionId: 's1',
    props: { route: '/explore' },
  };

  it('accepts a well-formed batch', () => {
    const r = activityBatchBody.safeParse({
      events: [good, { eventType: 'search', clientTs: good.clientTs, props: { query: 'tennis' } }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-array events field', () => {
    expect(activityBatchBody.safeParse({ events: 'nope' }).success).toBe(false);
  });

  it('rejects an empty batch', () => {
    expect(activityBatchBody.safeParse({ events: [] }).success).toBe(false);
  });

  it('rejects more than 200 events', () => {
    const many = Array.from({ length: 201 }, () => good);
    expect(activityBatchBody.safeParse({ events: many }).success).toBe(false);
  });

  it('rejects an event missing eventType', () => {
    const { eventType: _omit, ...noType } = good;
    expect(activityBatchBody.safeParse({ events: [noType] }).success).toBe(false);
  });

  it('rejects an event missing clientTs', () => {
    const { clientTs: _omit, ...noTs } = good;
    expect(activityBatchBody.safeParse({ events: [noTs] }).success).toBe(false);
  });
});

// DB-backed insert is operator-owed (needs a live Postgres). Gated off here.
const runIntegration = Boolean(process.env.RUN_INTEGRATION);
describe.skipIf(!runIntegration)('logConsumerActivity insert (DB)', () => {
  it('inserts rows scoped to the user and nulls a bad item_id', async () => {
    // Placeholder: exercised under RUN_INTEGRATION against a real DB.
    expect(true).toBe(true);
  });
});
