/**
 * Pure reservation rules — no I/O, fully unit-tested. The service and the
 * sweeper call into these so the policy lives in one place.
 */

export interface ReservationPolicy {
  defaultMinutes: number;
  maxMinutes: number;
  idleWarnMs: number;
  idleReleaseMs: number;
  offlineGraceMs: number;
}

export type SweepDecision =
  | { kind: 'NONE' }
  | { kind: 'WARN_IDLE'; releaseInSec: number }
  | { kind: 'RELEASE'; reason: 'IDLE' | 'EXPIRED' | 'DEVICE_OFFLINE' };

export interface SweepInput {
  now: number;
  endAt: number;
  reservationKind: 'INTERACTIVE' | 'AUTOMATION';
  /** Last controller input (or reservation start), epoch ms. */
  lastActivityAt: number;
  /** The lastActivityAt value we already warned about, so we warn once per idle period. */
  warnedForActivityAt: number | null;
  deviceOnline: boolean;
  deviceOfflineSince: number | null;
}

export function evaluateReservation(input: SweepInput, policy: ReservationPolicy): SweepDecision {
  if (input.now >= input.endAt) return { kind: 'RELEASE', reason: 'EXPIRED' };

  if (
    !input.deviceOnline &&
    input.deviceOfflineSince !== null &&
    input.now - input.deviceOfflineSince >= policy.offlineGraceMs
  ) {
    return { kind: 'RELEASE', reason: 'DEVICE_OFFLINE' };
  }

  // Automation runs have no human at the keyboard; only expiry applies.
  if (input.reservationKind === 'AUTOMATION') return { kind: 'NONE' };

  const idleMs = input.now - input.lastActivityAt;
  if (idleMs >= policy.idleReleaseMs) return { kind: 'RELEASE', reason: 'IDLE' };
  if (idleMs >= policy.idleWarnMs && input.warnedForActivityAt !== input.lastActivityAt) {
    return {
      kind: 'WARN_IDLE',
      releaseInSec: Math.max(0, Math.ceil((policy.idleReleaseMs - idleMs) / 1000)),
    };
  }
  return { kind: 'NONE' };
}

/** Clamp a requested duration to policy. */
export function resolveDurationMinutes(
  requested: number | undefined,
  policy: Pick<ReservationPolicy, 'defaultMinutes' | 'maxMinutes'>,
): number {
  const m = requested ?? policy.defaultMinutes;
  return Math.max(5, Math.min(m, policy.maxMinutes));
}

export type ExtendResult = { ok: true; endAt: Date } | { ok: false; reason: string };

/**
 * Extend a reservation by `minutes`, never beyond maxMinutes from its start and
 * never for one that already ended.
 */
export function computeExtension(
  r: { startAt: Date; endAt: Date },
  minutes: number,
  now: Date,
  policy: Pick<ReservationPolicy, 'maxMinutes'>,
): ExtendResult {
  if (r.endAt <= now) return { ok: false, reason: 'Reservation already ended' };
  const hardStop = r.startAt.getTime() + policy.maxMinutes * 60_000;
  const wanted = r.endAt.getTime() + minutes * 60_000;
  const endAt = Math.min(wanted, hardStop);
  if (endAt <= r.endAt.getTime()) {
    return { ok: false, reason: `Reservations are limited to ${policy.maxMinutes} minutes` };
  }
  return { ok: true, endAt: new Date(endAt) };
}

/** Redis lock TTL: reservation remainder plus a grace period so the sweeper releases first. */
export function lockTtlMs(endAt: Date, now: Date): number {
  return Math.max(60_000, endAt.getTime() - now.getTime() + 5 * 60_000);
}

export function reservationLimitFor(
  role: 'ADMIN' | 'LEAD' | 'TESTER' | 'VIEWER',
  limits: { ADMIN: number; LEAD: number; TESTER: number },
): number {
  return role === 'VIEWER' ? 0 : limits[role];
}

/** Packages cleanup should uninstall: installed in-session, minus the keep-list. */
export function packagesToRemove(installed: readonly string[], keep: readonly string[]): string[] {
  const keepSet = new Set(keep);
  return [...new Set(installed)].filter((p) => !keepSet.has(p));
}
