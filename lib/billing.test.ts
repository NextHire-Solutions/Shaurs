// Run: npx tsx --test lib/billing.test.ts
// Each case quotes the "Health Dash Major Changes" document it pins down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billingDueInWeek,
  billingSnapshot,
  completedCycles,
  scheduleFor,
  type BillingClient,
} from './billing';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (day: string) => `${day}T15:00:00Z`;

// Billing dates Sept 11, Sept 25, Oct 9 — the document's example. Go-live the
// day after Sept 11 puts the first 28-day block at Sept 11 → Oct 9.
const GO_LIVE = '2026-09-12';

function client(over: Partial<BillingClient> = {}): BillingClient {
  return {
    billing_anchor_date: '2026-09-11',
    start_date: '2026-08-01',
    billing_interval: 'biweekly',
    billing_interval_days: null,
    monthly_target: 8,
    intro_dates: [],
    ...over,
  };
}

test('"An 8-intro monthly target means 4 intros are due per 14-day billing cycle"', () => {
  const s = scheduleFor(client(), GO_LIVE)!;
  assert.equal(s.cycleTarget, 4);
  const snap = billingSnapshot(client(), new Date('2026-09-20T12:00:00Z'), GO_LIVE)!;
  assert.equal(snap.cycle.target, 4);
  assert.equal(snap.period.target, 8, '8 intros due per 28-day period');
});

test('"Sept 11 → Sept 25 = cycle 1, Sept 25 → Oct 9 = cycle 2, Sept 11 → Oct 9 = 28-day period"', () => {
  const c = client();
  const inCycle1 = billingSnapshot(c, new Date('2026-09-20T12:00:00Z'), GO_LIVE)!;
  assert.equal(iso(inCycle1.cycle.start), '2026-09-11');
  assert.equal(iso(inCycle1.cycle.end), '2026-09-25');
  const inCycle2 = billingSnapshot(c, new Date('2026-09-30T12:00:00Z'), GO_LIVE)!;
  assert.equal(iso(inCycle2.cycle.start), '2026-09-25');
  assert.equal(iso(inCycle2.cycle.end), '2026-10-09');
  assert.equal(iso(inCycle2.period.start), '2026-09-11');
  assert.equal(iso(inCycle2.period.end), '2026-10-09');
  assert.equal(inCycle2.period.totalDays, 28);
});

test('"Monthly … combine the intros from both 14-day billing cycles" → 6/8', () => {
  const c = client({
    intro_dates: [at('2026-09-12'), at('2026-09-15'), at('2026-09-20'), at('2026-09-26'), at('2026-09-28'), at('2026-10-01')],
  });
  const snap = billingSnapshot(c, new Date('2026-10-02T12:00:00Z'), GO_LIVE)!;
  assert.equal(snap.period.delivered, 6);
  assert.equal(snap.period.target, 8);
});

test('"The Monthly number should reset after the full 28-day period, not after each 14-day cycle"', () => {
  const c = client({ intro_dates: [at('2026-09-15'), at('2026-09-20'), at('2026-09-30')] });
  // Crossing the Sept 25 billing date (mid-block) does NOT reset.
  const midBlock = billingSnapshot(c, new Date('2026-10-01T12:00:00Z'), GO_LIVE)!;
  assert.equal(midBlock.period.delivered, 3);
  // Crossing Oct 9 (end of the 28-day block) does.
  const nextBlock = billingSnapshot(c, new Date('2026-10-10T12:00:00Z'), GO_LIVE)!;
  assert.equal(iso(nextBlock.period.start), '2026-10-09');
  assert.equal(nextBlock.period.delivered, 0);
});

test('An intro made ON a billing date counts toward the cycle billed that day', () => {
  const c = client({ intro_dates: [at('2026-09-25')] });
  const snap = billingSnapshot(c, new Date('2026-09-25T20:00:00Z'), GO_LIVE)!;
  assert.equal(iso(snap.cycle.end), '2026-09-25');
  assert.equal(snap.cycle.delivered, 1);
});

test('Carry-forward example: "target 4, delivered 2, carry-forward 2, total required 6"', () => {
  // Cycle Sept 25 → Oct 9 (the first after go-live) delivers 2 of 4.
  // Cycle Oct 9 → Oct 23 then owes 4 + 2 carried = 6, and 2 are in so far.
  const c = client({
    intro_dates: [at('2026-09-27'), at('2026-10-02'), at('2026-10-11'), at('2026-10-12')],
  });
  const snap = billingSnapshot(c, new Date('2026-10-13T12:00:00Z'), GO_LIVE)!;
  assert.equal(iso(snap.cycle.start), '2026-10-09');
  assert.equal(snap.cycle.target, 4);
  assert.equal(snap.cycle.delivered, 2);
  assert.equal(snap.cycle.carryIn, 2);
  assert.equal(snap.cycle.required, 6);
  assert.equal(snap.cycle.remaining, 4);
});

test('Carry-forward starts fresh at go-live: the cycle in progress at go-live never carries', () => {
  // Nothing delivered Sept 11 → Sept 25 (in progress at go-live) — no carry.
  const snap = billingSnapshot(client(), new Date('2026-09-30T12:00:00Z'), GO_LIVE)!;
  assert.equal(snap.cycle.carryIn, 0);
});

test('Carry keeps accumulating across cycles, and over-delivery pays it down without banking credit', () => {
  // Sept 25 → Oct 9: 0 of 4 → carry 4. Oct 9 → Oct 23: 10 delivered of 8 → carry 0, not −2.
  const ten = Array.from({ length: 10 }, (_, i) => at(`2026-10-${String(10 + i).padStart(2, '0')}`));
  const c = client({ intro_dates: ten });
  const s1 = billingSnapshot(c, new Date('2026-10-12T12:00:00Z'), GO_LIVE)!;
  assert.equal(s1.cycle.carryIn, 4);
  assert.equal(s1.cycle.required, 8);
  const s2 = billingSnapshot(c, new Date('2026-10-25T12:00:00Z'), GO_LIVE)!;
  assert.equal(s2.cycle.carryIn, 0);
  assert.equal(s2.cycle.required, 4);

  const none = client();
  const s3 = billingSnapshot(none, new Date('2026-10-25T12:00:00Z'), GO_LIVE)!;
  assert.equal(s3.cycle.carryIn, 8, '4 missed Sept 25→Oct 9, then 8 missed Oct 9→Oct 23');
});

test('Status is measured against the full 28-day target, by where the client stands in the period', () => {
  // Period Sept 11 → Oct 9. Day 14 (Sept 25): pace = 8 × 14/28 = 4.
  const three = client({ intro_dates: [at('2026-09-12'), at('2026-09-13'), at('2026-09-14')] });
  assert.equal(billingSnapshot(three, new Date('2026-09-25T12:00:00Z'), GO_LIVE)!.status, 'risk');
  const four = client({ intro_dates: [at('2026-09-12'), at('2026-09-13'), at('2026-09-14'), at('2026-09-15')] });
  assert.equal(billingSnapshot(four, new Date('2026-09-25T12:00:00Z'), GO_LIVE)!.status, 'ok');
  // Day 1 needs floor(8/28) = 0 → a brand-new period is not at risk.
  assert.equal(billingSnapshot(client(), new Date('2026-09-12T12:00:00Z'), GO_LIVE)!.status, 'ok');
  const eight = client({ intro_dates: Array.from({ length: 8 }, () => at('2026-09-20')) });
  assert.equal(billingSnapshot(eight, new Date('2026-09-21T12:00:00Z'), GO_LIVE)!.status, 'done');
  assert.equal(billingSnapshot(client({ monthly_target: 0 }), new Date('2026-09-21T12:00:00Z'), GO_LIVE)!.status, 'pending');
});

test('Carry owed into a new period must be delivered before the client is on track', () => {
  // Oct 9 → Nov 6 block starts owing 4 carried from Sept 25 → Oct 9 (nothing delivered).
  const snap = billingSnapshot(client(), new Date('2026-10-10T12:00:00Z'), GO_LIVE)!;
  assert.equal(snap.period.carryIn, 4);
  assert.equal(snap.status, 'risk');
});

test('Performance: "4 intros are added to the performance target for that week" only when billing falls in it', () => {
  const c = client();
  // Week Mon Oct 5 – Sun Oct 11 contains the Oct 9 billing date.
  const due = billingDueInWeek(c, new Date('2026-10-05T00:00:00Z'), new Date('2026-10-20T12:00:00Z'), GO_LIVE)!;
  assert.equal(iso(due.billingDate), '2026-10-09');
  assert.equal(due.due, 4);
  // Week Mon Sept 28 – Sun Oct 4 has no billing date for this client.
  assert.equal(billingDueInWeek(c, new Date('2026-09-28T00:00:00Z'), new Date('2026-10-20T12:00:00Z'), GO_LIVE), null);
});

test('Performance: carried intros count only in the week the client bills', () => {
  // Nothing delivered Sept 25 → Oct 9, so the Oct 23 billing owes 4 + 4.
  const due = billingDueInWeek(client(), new Date('2026-10-19T00:00:00Z'), new Date('2026-10-30T12:00:00Z'), GO_LIVE)!;
  assert.equal(iso(due.billingDate), '2026-10-23');
  assert.equal(due.carryIn, 4);
  assert.equal(due.due, 8);
});

test('28-day billing: one cycle per period, cycle target = monthly target', () => {
  const s = scheduleFor(client({ billing_interval: '28-days' }), GO_LIVE)!;
  assert.equal(s.cycleTarget, 8);
  assert.equal(s.cyclesPerBlock, 1);
});

test('Monthly billing: calendar-month cycles, clamped to month end', () => {
  const c = client({ billing_interval: 'monthly', billing_anchor_date: '2026-01-31', start_date: '2026-01-31' });
  const snap = billingSnapshot(c, new Date('2026-03-05T12:00:00Z'), GO_LIVE)!;
  assert.equal(iso(snap.cycle.start), '2026-02-28');
  assert.equal(iso(snap.cycle.end), '2026-03-31');
  assert.equal(snap.cycle.target, 8);
});

test('No anchor and no start date → no schedule', () => {
  assert.equal(billingSnapshot(client({ billing_anchor_date: null, start_date: null }), new Date(), GO_LIVE), null);
});

test('Completed cycles feed the Client Score (base target, most recent first)', () => {
  const c = client({ intro_dates: [at('2026-09-13'), at('2026-09-27'), at('2026-09-28')] });
  const done = completedCycles(c, new Date('2026-10-10T12:00:00Z'), 4);
  assert.deepEqual(done.slice(0, 2), [
    { target: 4, delivered: 2 }, // Sept 25 → Oct 9
    { target: 4, delivered: 1 }, // Sept 11 → Sept 25
  ]);
});
