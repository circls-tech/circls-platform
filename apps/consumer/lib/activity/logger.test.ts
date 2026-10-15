import { describe, expect, it, vi } from 'vitest';
import { ActivityLogger, MAX_BATCH, routePattern, type ActivityEvent } from './logger';

function make(opts: Partial<ConstructorParameters<typeof ActivityLogger>[0]> = {}) {
  const sent: ActivityEvent[][] = [];
  const send = vi.fn(async (events: ActivityEvent[]) => {
    sent.push(events);
  });
  const logger = new ActivityLogger({
    send,
    sessionId: 's1',
    now: () => new Date('2026-10-16T10:00:00.000Z'),
    ...opts,
  });
  return { logger, send, sent };
}

describe('ActivityLogger', () => {
  it('stamps the session id and client time on every event', () => {
    const { logger } = make();
    logger.log('screen_view', { props: { route: '/events/[id]' } });
    expect(logger.pendingCount).toBe(1);
  });

  it('sends nothing until ready, then drains the queue', async () => {
    const { logger, send, sent } = make({ batchThreshold: 2 });
    logger.log('screen_view');
    logger.log('search', { props: { query: 'tennis' } });
    logger.log('item_view', { itemType: 'event', itemId: 'e1' });
    expect(send).not.toHaveBeenCalled();
    expect(logger.pendingCount).toBe(3);

    logger.setReady(true);
    await logger.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((e) => e.eventType)).toEqual(['screen_view', 'search', 'item_view']);
    expect(sent[0]![0]).toMatchObject({ sessionId: 's1', clientTs: '2026-10-16T10:00:00.000Z' });
    expect(logger.pendingCount).toBe(0);
  });

  it('flushes on its own once the threshold is reached while ready', async () => {
    const { logger, sent } = make({ batchThreshold: 2 });
    logger.setReady(true);
    logger.log('a');
    expect(sent).toHaveLength(0);
    logger.log('b');
    await logger.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
  });

  it('drops the oldest events once the queue is full', () => {
    const { logger } = make({ maxQueue: 3 });
    for (const t of ['a', 'b', 'c', 'd']) logger.log(t);
    expect(logger.pendingCount).toBe(3);
  });

  it('splits a large queue into batches the API accepts', async () => {
    const { logger, sent } = make({ batchThreshold: 10_000, maxQueue: 1000 });
    for (let i = 0; i < MAX_BATCH + 5; i++) logger.log('heartbeat');
    logger.setReady(true);
    await logger.flush();
    expect(sent.map((b) => b.length)).toEqual([MAX_BATCH, 5]);
  });

  it('swallows a failed send and drops that batch', async () => {
    const send = vi.fn(async () => {
      throw new Error('offline');
    });
    const logger = new ActivityLogger({ send, sessionId: 's1' });
    logger.log('a');
    logger.setReady(true);
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(logger.pendingCount).toBe(0);
  });

  it('restores persisted events ahead of new ones and ignores junk', async () => {
    const { logger, sent } = make();
    logger.log('new');
    logger.restore([
      { eventType: 'old', clientTs: '2026-10-16T09:00:00.000Z', sessionId: 's1' },
      { eventType: 42 } as unknown as ActivityEvent,
    ]);
    logger.setReady(true);
    await logger.flush();
    expect(sent[0]!.map((e) => e.eventType)).toEqual(['old', 'new']);
  });

  it('reports queue changes so the provider can persist them', () => {
    const onChange = vi.fn();
    const { logger } = make({ onChange });
    logger.log('a');
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ eventType: 'a' })]));
  });
});

describe('routePattern', () => {
  it('replaces uuid segments with [id] and keeps the rest', () => {
    expect(routePattern('/events/0193a4f2-1b2c-4d5e-8f90-123456789abc')).toBe('/events/[id]');
    expect(routePattern('/me/bookings')).toBe('/me/bookings');
    expect(routePattern('/')).toBe('/');
  });
});
