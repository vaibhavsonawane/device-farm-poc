import { describe, expect, it } from 'vitest';
import {
  type ReservationPolicy,
  type SweepInput,
  computeExtension,
  evaluateReservation,
  lockTtlMs,
  packagesToRemove,
  reservationLimitFor,
  resolveDurationMinutes,
} from './reservation-logic';

const MIN = 60_000;
const policy: ReservationPolicy = {
  defaultMinutes: 30,
  maxMinutes: 120,
  idleWarnMs: 5 * MIN,
  idleReleaseMs: 10 * MIN,
  offlineGraceMs: 3 * MIN,
};

const t0 = 1_700_000_000_000;
const base: SweepInput = {
  now: t0,
  endAt: t0 + 30 * MIN,
  reservationKind: 'INTERACTIVE',
  lastActivityAt: t0,
  warnedForActivityAt: null,
  deviceOnline: true,
  deviceOfflineSince: null,
};

describe('evaluateReservation', () => {
  it('does nothing while the user is active', () => {
    expect(evaluateReservation({ ...base, now: t0 + 4 * MIN }, policy)).toEqual({ kind: 'NONE' });
  });

  it('warns at the idle-warn threshold with the remaining seconds', () => {
    expect(evaluateReservation({ ...base, now: t0 + 5 * MIN }, policy)).toEqual({
      kind: 'WARN_IDLE',
      releaseInSec: 300,
    });
    expect(evaluateReservation({ ...base, now: t0 + 8 * MIN }, policy)).toEqual({
      kind: 'WARN_IDLE',
      releaseInSec: 120,
    });
  });

  it('warns only once per idle period', () => {
    expect(
      evaluateReservation({ ...base, now: t0 + 6 * MIN, warnedForActivityAt: t0 }, policy),
    ).toEqual({ kind: 'NONE' });
    // New activity, then idle again → warns again.
    const later = {
      ...base,
      lastActivityAt: t0 + 7 * MIN,
      warnedForActivityAt: t0,
      now: t0 + 12 * MIN,
    };
    expect(evaluateReservation(later, policy).kind).toBe('WARN_IDLE');
  });

  it('releases after the idle-release threshold even if already warned', () => {
    expect(
      evaluateReservation({ ...base, now: t0 + 10 * MIN, warnedForActivityAt: t0 }, policy),
    ).toEqual({ kind: 'RELEASE', reason: 'IDLE' });
  });

  it('expiry wins over everything else', () => {
    expect(
      evaluateReservation({ ...base, now: base.endAt, lastActivityAt: base.endAt }, policy),
    ).toEqual({ kind: 'RELEASE', reason: 'EXPIRED' });
  });

  it('never idles out automation reservations', () => {
    expect(
      evaluateReservation({ ...base, reservationKind: 'AUTOMATION', now: t0 + 25 * MIN }, policy),
    ).toEqual({ kind: 'NONE' });
    expect(
      evaluateReservation({ ...base, reservationKind: 'AUTOMATION', now: base.endAt + 1 }, policy)
        .kind,
    ).toBe('RELEASE');
  });

  it('releases a device that stayed offline past the grace period', () => {
    const offline = { ...base, deviceOnline: false, deviceOfflineSince: t0 };
    expect(evaluateReservation({ ...offline, now: t0 + 2 * MIN }, policy)).toEqual({
      kind: 'NONE',
    });
    expect(evaluateReservation({ ...offline, now: t0 + 3 * MIN }, policy)).toEqual({
      kind: 'RELEASE',
      reason: 'DEVICE_OFFLINE',
    });
  });
});

describe('durations and extensions', () => {
  it('clamps requested durations', () => {
    expect(resolveDurationMinutes(undefined, policy)).toBe(30);
    expect(resolveDurationMinutes(1, policy)).toBe(5);
    expect(resolveDurationMinutes(999, policy)).toBe(120);
  });

  it('extends within the max window', () => {
    const r = { startAt: new Date(t0), endAt: new Date(t0 + 30 * MIN) };
    const res = computeExtension(r, 30, new Date(t0 + 10 * MIN), policy);
    expect(res).toEqual({ ok: true, endAt: new Date(t0 + 60 * MIN) });
  });

  it('caps an extension at maxMinutes from start', () => {
    const r = { startAt: new Date(t0), endAt: new Date(t0 + 100 * MIN) };
    expect(computeExtension(r, 60, new Date(t0 + 50 * MIN), policy)).toEqual({
      ok: true,
      endAt: new Date(t0 + 120 * MIN),
    });
  });

  it('refuses when already at the cap or ended', () => {
    const atCap = { startAt: new Date(t0), endAt: new Date(t0 + 120 * MIN) };
    expect(computeExtension(atCap, 15, new Date(t0 + 60 * MIN), policy).ok).toBe(false);
    const ended = { startAt: new Date(t0), endAt: new Date(t0 + 30 * MIN) };
    expect(computeExtension(ended, 15, new Date(t0 + 31 * MIN), policy)).toEqual({
      ok: false,
      reason: 'Reservation already ended',
    });
  });

  it('lock TTL outlives the reservation', () => {
    expect(lockTtlMs(new Date(t0 + 30 * MIN), new Date(t0))).toBe(35 * MIN);
    expect(lockTtlMs(new Date(t0 - MIN), new Date(t0))).toBe(4 * MIN);
    expect(lockTtlMs(new Date(t0 - 10 * MIN), new Date(t0))).toBe(60_000);
  });
});

describe('limits and cleanup', () => {
  it('gives viewers no reservations', () => {
    const limits = { ADMIN: 10, LEAD: 4, TESTER: 2 };
    expect(reservationLimitFor('VIEWER', limits)).toBe(0);
    expect(reservationLimitFor('TESTER', limits)).toBe(2);
  });

  it('keeps allow-listed packages and de-duplicates', () => {
    expect(packagesToRemove(['a.b', 'c.d', 'a.b', 'keep.me'], ['keep.me'])).toEqual(['a.b', 'c.d']);
  });
});
