import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    INR_FAILOVER_THRESHOLD: 3,
    INR_FAILOVER_WINDOW_SEC: 60,
    INR_FAILOVER_COOLDOWN_SEC: 600,
  },
}));

import {
  __resetInrFailoverForTesting,
  cashfreeFailoverState,
  clearCashfreeFailover,
  isCashfreeFailoverActive,
  recordCashfreeOutage,
} from './inr_failover.js';

afterEach(() => __resetInrFailoverForTesting());

const T0 = 1_800_000_000_000;

describe('INR failover breaker', () => {
  it('stays off below the threshold', () => {
    recordCashfreeOutage(T0);
    recordCashfreeOutage(T0 + 1000);
    expect(isCashfreeFailoverActive(T0 + 2000)).toBe(false);
    expect(cashfreeFailoverState(T0 + 2000)).toEqual({ active: false, until: null, recentOutages: 2 });
  });

  it('turns on at the threshold and off after the cooldown', () => {
    recordCashfreeOutage(T0);
    recordCashfreeOutage(T0 + 1000);
    recordCashfreeOutage(T0 + 2000);
    expect(isCashfreeFailoverActive(T0 + 2001)).toBe(true);
    expect(cashfreeFailoverState(T0 + 2001).until).toBe(new Date(T0 + 2000 + 600_000).toISOString());
    expect(isCashfreeFailoverActive(T0 + 2000 + 600_000)).toBe(false);
  });

  it('only counts outages inside the window', () => {
    recordCashfreeOutage(T0);
    recordCashfreeOutage(T0 + 1000);
    // 61 s later the first two have aged out.
    recordCashfreeOutage(T0 + 61_001);
    expect(isCashfreeFailoverActive(T0 + 61_002)).toBe(false);
    expect(cashfreeFailoverState(T0 + 61_002).recentOutages).toBe(1);
  });

  it('an admin can end it early', () => {
    for (let i = 0; i < 3; i++) recordCashfreeOutage(T0 + i);
    expect(isCashfreeFailoverActive(T0 + 10)).toBe(true);
    clearCashfreeFailover();
    expect(isCashfreeFailoverActive(T0 + 10)).toBe(false);
  });
});
