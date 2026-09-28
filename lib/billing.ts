// Billing-cycle engine: intros due, delivered, carried forward, the 28-day
// period, and At Risk / On Track — all measured against each client's own
// billing schedule and monthly target. Pure: no database, no clock except the
// `asOf` date passed in, so every rule is unit-testable (billing.test.ts).
//
// Vocabulary (from "Health Dash Major Changes"):
//   billing date   A day the client is billed. Every `step` days from the
//                  anchor (14, 28, custom N) or every calendar month.
//   cycle          Billing date → next billing date. Intros made ON a billing
//                  date count toward the cycle that bills that day, so a cycle
//                  is (start, end] in whole UTC days. Matches the sync worker's
//                  long-standing "intros since last billing" convention.
//   cycle target   What one cycle owes: monthly target ÷ 2 for 14-day billing
//                  (8/month → 4 per cycle), the full monthly target for 28-day
//                  and monthly billing.
//   carry-forward  A cycle's shortfall, added to the next cycle's due. Starts
//                  at 0 from the first billing date after CARRY_FORWARD_START;
//                  over-delivery pays a carried shortfall down but never banks
//                  credit.
//   28-day period  Fixed back-to-back blocks of cycles (two 14-day cycles, or
//                  one 28-day / monthly cycle). The Monthly number resets when
//                  a block ends, never mid-block. Blocks are phased from the
//                  cycle in progress on CARRY_FORWARD_START, not the anchor.

import type { BillingInterval } from './types';

/** Go-live of carry-forward and 28-day blocks. Change here to re-phase. */
export const CARRY_FORWARD_START = '2026-09-28';

const DAY_MS = 86_400_000;

/** Whole UTC days since the epoch. All comparisons happen in these units. */
export function dayNumber(d: Date | string): number {
  const t =
    typeof d === 'string'
      ? /^\d{4}-\d{2}-\d{2}$/.test(d)
        ? Date.parse(d + 'T00:00:00Z')
        : Date.parse(d)
      : d.getTime();
  return Math.floor(t / DAY_MS);
}

export function dayToDate(day: number): Date {
  return new Date(day * DAY_MS);
}

export interface BillingClient {
  billing_anchor_date: string | null;
  start_date: string | null;
  billing_interval: BillingInterval;
  billing_interval_days: number | null;
  monthly_target: number;
  intro_dates: string[];
}

export interface Schedule {
  /** Day of billing date k (k may be negative: cycles before the anchor). */
  billingDay: (k: number) => number;
  /** k such that billingDay(k) < day <= billingDay(k + 1). */
  cycleIndexOf: (day: number) => number;
  cycleTarget: number;
  cyclesPerBlock: number;
  /** First cycle that starts on/after the client's start — no partial cycles. */
  firstFullCycle: number;
  /** Cycle in progress on CARRY_FORWARD_START (or the first full cycle, if later). */
  blockPhase: number;
  /** First cycle whose shortfall can carry (the one after go-live). */
  carryStart: number;
  /** Sorted intro days. */
  introDays: number[];
}

function addMonthsClamped(day: number, months: number): number {
  const d = dayToDate(day);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  return dayNumber(new Date(Date.UTC(targetY, targetM, Math.min(d.getUTCDate(), lastDay))));
}

function stepDays(c: BillingClient): number | null {
  if (c.billing_interval === 'biweekly') return 14;
  if (c.billing_interval === '28-days') return 28;
  if (c.billing_interval === 'custom') {
    const n = c.billing_interval_days;
    return n && n > 0 ? Math.floor(n) : null;
  }
  return null; // monthly
}

/** Null when the client has no anchor/start date or an unusable custom interval. */
export function scheduleFor(c: BillingClient, goLive: string = CARRY_FORWARD_START): Schedule | null {
  const anchorISO = c.billing_anchor_date ?? c.start_date;
  if (!anchorISO) return null;
  const anchor = dayNumber(anchorISO);
  if (!Number.isFinite(anchor)) return null;
  const monthly = Math.max(0, c.monthly_target ?? 0);

  let billingDay: (k: number) => number;
  let cycleIndexOf: (day: number) => number;
  let cycleTarget: number;
  let cyclesPerBlock: number;

  if (c.billing_interval === 'monthly') {
    billingDay = (k) => addMonthsClamped(anchor, k);
    cycleIndexOf = (day) => {
      // Estimate from 30.44-day months, then walk to the exact cycle.
      let k = Math.ceil((day - anchor) / 30.44) - 1;
      while (billingDay(k) >= day) k--;
      while (billingDay(k + 1) < day) k++;
      return k;
    };
    cycleTarget = monthly;
    cyclesPerBlock = 1;
  } else {
    const step = stepDays(c);
    if (step === null) return null;
    billingDay = (k) => anchor + k * step;
    cycleIndexOf = (day) => Math.ceil((day - anchor) / step) - 1;
    cycleTarget = step === 14 ? monthly / 2 : step === 28 ? monthly : Math.round((monthly * step) / 28);
    cyclesPerBlock = Math.max(1, Math.round(28 / step));
  }

  const startDay = dayNumber(c.start_date ?? anchorISO);
  let firstFullCycle = cycleIndexOf(startDay);
  while (billingDay(firstFullCycle) < startDay) firstFullCycle++;
  const goLiveCycle = cycleIndexOf(dayNumber(goLive));

  const introDays = (c.intro_dates ?? [])
    .map((s) => dayNumber(s))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  return {
    billingDay,
    cycleIndexOf,
    cycleTarget,
    cyclesPerBlock,
    firstFullCycle,
    blockPhase: Math.max(goLiveCycle, firstFullCycle),
    carryStart: Math.max(goLiveCycle + 1, firstFullCycle),
    introDays,
  };
}

/** Intros with lo < day <= hi. */
function countIntros(days: number[], lo: number, hi: number): number {
  if (hi <= lo) return 0;
  const upper = (x: number) => {
    let a = 0;
    let b = days.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (days[mid] <= x) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  return upper(hi) - upper(lo);
}

export interface CycleState {
  index: number;
  /** Billing date that opened the cycle (exclusive). */
  start: Date;
  /** Billing date the cycle is due on (inclusive). */
  end: Date;
  target: number;
  carryIn: number;
  /** target + carryIn — the total intros now required this cycle. */
  required: number;
  /** Intros in the cycle up to asOf. */
  delivered: number;
  /** max(0, required − delivered). */
  remaining: number;
}

/** One cycle's numbers as of `asOfDay`, with carry replayed from carryStart. */
export function cycleState(s: Schedule, k: number, asOfDay: number): CycleState {
  let carry = 0;
  for (let j = s.carryStart; j < k; j++) {
    const delivered = countIntros(s.introDays, s.billingDay(j), s.billingDay(j + 1));
    carry = Math.max(0, s.cycleTarget + carry - delivered);
  }
  const startDay = s.billingDay(k);
  const endDay = s.billingDay(k + 1);
  const delivered = countIntros(s.introDays, startDay, Math.min(endDay, asOfDay));
  const required = s.cycleTarget + carry;
  return {
    index: k,
    start: dayToDate(startDay),
    end: dayToDate(endDay),
    target: s.cycleTarget,
    carryIn: carry,
    required,
    delivered,
    remaining: Math.max(0, required - delivered),
  };
}

export type BillingStatus = 'pending' | 'risk' | 'ok' | 'done';

export interface PeriodState {
  start: Date;
  end: Date;
  /** Sum of the block's base cycle targets (= the monthly target). */
  target: number;
  /** Carry owed into the block's first cycle from the previous block. */
  carryIn: number;
  delivered: number;
  elapsedDays: number;
  totalDays: number;
  /** floor(carryIn + target × elapsed / total): what "on pace" requires today. */
  expected: number;
}

export interface BillingSnapshot {
  cycle: CycleState;
  period: PeriodState;
  status: BillingStatus;
}

/**
 * Everything the dashboard shows about a client's billing progress as of a
 * date: the current cycle (Intros / Billing), the current 28-day period
 * (Monthly) and the status pill. Null when there is no schedule at all.
 *
 * Status:
 *   pending  no monthly target set
 *   done     the period's intros, including any carry owed into it, are in
 *   ok       delivered is at or ahead of pace for this point in the period
 *   risk     behind pace — which includes still owing carried-forward intros
 */
export function billingSnapshot(
  c: BillingClient,
  asOf: Date,
  goLive: string = CARRY_FORWARD_START,
): BillingSnapshot | null {
  const s = scheduleFor(c, goLive);
  if (!s) return null;
  const asOfDay = dayNumber(asOf);
  const k = s.cycleIndexOf(asOfDay);
  const cycle = cycleState(s, k, asOfDay);

  const offset = Math.floor((k - s.blockPhase) / s.cyclesPerBlock) * s.cyclesPerBlock;
  const firstK = s.blockPhase + offset;
  const startDay = s.billingDay(firstK);
  const endDay = s.billingDay(firstK + s.cyclesPerBlock);
  const firstCycle = firstK === k ? cycle : cycleState(s, firstK, asOfDay);
  const target = s.cycleTarget * s.cyclesPerBlock;
  const delivered = countIntros(s.introDays, startDay, Math.min(endDay, asOfDay));
  const totalDays = endDay - startDay;
  const elapsedDays = Math.max(0, Math.min(totalDays, asOfDay - startDay));
  const expected = Math.floor(
    firstCycle.carryIn + (target * elapsedDays) / Math.max(1, totalDays) + 1e-9,
  );
  const period: PeriodState = {
    start: dayToDate(startDay),
    end: dayToDate(endDay),
    target,
    carryIn: firstCycle.carryIn,
    delivered,
    elapsedDays,
    totalDays,
    expected,
  };

  let status: BillingStatus;
  if (target <= 0) status = 'pending';
  else if (delivered >= target + firstCycle.carryIn) status = 'done';
  else if (delivered >= expected) status = 'ok';
  else status = 'risk';

  return { cycle, period, status };
}

export interface BillingDueInWeek {
  billingDate: Date;
  /** Cycle target + carry-forward — what this billing date requires. */
  due: number;
  delivered: number;
  carryIn: number;
}

/**
 * The cycle that bills inside the Monday→Sunday week starting `monday`, or
 * null when the client has no billing date that week. Drives Performance:
 * only clients billing in a week add to that week's due, and only then does
 * their carry-forward count.
 */
export function billingDueInWeek(
  c: BillingClient,
  monday: Date,
  asOf: Date,
  goLive: string = CARRY_FORWARD_START,
): BillingDueInWeek | null {
  const s = scheduleFor(c, goLive);
  if (!s) return null;
  const mon = dayNumber(monday);
  const sun = mon + 6;
  // Cycle k ends on billingDay(k+1); find the one ending within [mon, sun].
  const k = s.cycleIndexOf(sun);
  const endDay = s.billingDay(k + 1);
  const due = endDay >= mon && endDay <= sun ? k : k - 1;
  const dueEnd = s.billingDay(due + 1);
  if (dueEnd < mon || dueEnd > sun) return null;
  if (due < s.firstFullCycle) return null;
  const st = cycleState(s, due, Math.min(dayNumber(asOf), dueEnd));
  return { billingDate: st.end, due: st.required, delivered: st.delivered, carryIn: st.carryIn };
}

/** Last `n` completed cycles (base target, no carry) — for the Client Score. */
export function completedCycles(
  c: BillingClient,
  asOf: Date,
  n: number,
): { target: number; delivered: number }[] {
  const s = scheduleFor(c);
  if (!s || s.cycleTarget <= 0) return [];
  const asOfDay = dayNumber(asOf);
  const current = s.cycleIndexOf(asOfDay);
  const out: { target: number; delivered: number }[] = [];
  for (let k = current - 1; k >= s.firstFullCycle && out.length < n; k--) {
    out.push({
      target: s.cycleTarget,
      delivered: countIntros(s.introDays, s.billingDay(k), s.billingDay(k + 1)),
    });
  }
  return out;
}
