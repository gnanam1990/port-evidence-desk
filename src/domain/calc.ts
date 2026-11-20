import type { Db } from '../db.ts';
import { all, one } from '../db.ts';
import { newId, sha256Hex } from '../util/crypto.ts';
import { canonicalJson } from '../util/canonical.ts';
import { addDays, daysBetween, eachDate, isoNow } from '../util/dates.ts';
import { audit } from './audit.ts';
import { refreshCaseState } from './state.ts';

export interface TariffRow {
  id: string;
  tenant_id: string;
  terminal_id: string;
  version: string;
  currency: string;
  terminal_tz: string;
  clock_trigger: string;
  free_days: number;
  include_trigger_day: number;
  include_end_day: number;
  exempt_weekends: number;
  exempt_closures: number;
  rate_tiers: string;
  closure_dates: string;
  effective_from: string;
  effective_to: string | null;
}

export interface RateTier {
  from_day: number;
  to_day: number | null;
  rate_minor: number;
}

export interface DayRow {
  date: string;
  kind: 'free' | 'chargeable' | 'closure_exempt' | 'weekend_exempt' | 'end_excluded' | 'pre_trigger';
  chargeable_day: number | null;
  tier: RateTier | null;
  charge_minor: number;
  note: string;
}

export interface Scenario {
  label: string;
  gate_out_date: string;
  days: DayRow[];
  expected_minor: number;
}

function tierFor(tiers: RateTier[], chargeableDay: number): RateTier | null {
  for (const t of tiers) {
    if (chargeableDay >= t.from_day && (t.to_day === null || chargeableDay <= t.to_day)) return t;
  }
  return null;
}

function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Build the per-day terminal-local ledger for one trigger→end window. */
export function computeDayLedger(
  tariff: TariffRow,
  triggerDate: string,
  endDate: string,
): { days: DayRow[]; expected_minor: number } {
  const tiers = JSON.parse(tariff.rate_tiers) as RateTier[];
  const closures = new Set(JSON.parse(tariff.closure_dates) as string[]);
  const days: DayRow[] = [];
  let chargeableOrdinal = 0;
  let expected = 0;
  const lastDate = endDate;
  const freeStartOffset = tariff.include_trigger_day ? 0 : 1;
  for (const date of eachDate(triggerDate, endDate)) {
    const daysSinceTrigger = daysBetween(triggerDate, date);
    if (daysSinceTrigger < freeStartOffset) {
      days.push({
        date, kind: 'pre_trigger', chargeable_day: null, tier: null, charge_minor: 0,
        note: 'clock trigger day; free window starts on the following day',
      });
      continue;
    }
    const freeIndex = daysSinceTrigger - freeStartOffset;
    if (freeIndex < tariff.free_days) {
      days.push({
        date, kind: 'free', chargeable_day: null, tier: null, charge_minor: 0,
        note: `free day ${freeIndex + 1} of ${tariff.free_days}`,
      });
      continue;
    }
    if (date === lastDate && !tariff.include_end_day) {
      days.push({
        date, kind: 'end_excluded', chargeable_day: null, tier: null, charge_minor: 0,
        note: 'gate-out day excluded by tariff configuration',
      });
      continue;
    }
    if (tariff.exempt_closures && closures.has(date)) {
      days.push({
        date, kind: 'closure_exempt', chargeable_day: null, tier: null, charge_minor: 0,
        note: 'terminal closure calendar date',
      });
      continue;
    }
    if (tariff.exempt_weekends && isWeekend(date)) {
      days.push({
        date, kind: 'weekend_exempt', chargeable_day: null, tier: null, charge_minor: 0,
        note: 'weekend exempt by tariff configuration',
      });
      continue;
    }
    chargeableOrdinal += 1;
    const tier = tierFor(tiers, chargeableOrdinal);
    const charge = tier?.rate_minor ?? 0;
    expected += charge;
    days.push({
      date, kind: 'chargeable', chargeable_day: chargeableOrdinal, tier, charge_minor: charge,
      note: tier
        ? `chargeable day ${chargeableOrdinal} at ${tier.rate_minor} minor`
        : `chargeable day ${chargeableOrdinal} has no matching rate tier`,
    });
  }
  return { days, expected_minor: expected };
}

interface CaseRow {
  id: string;
  tenant_id: string;
  tariff_id: string | null;
  state: string;
  currency: string;
}

interface EventRow {
  id: string;
  type: string;
  local_date: string;
  status: string;
  supplier: string;
  record_id: string;
  revision: number;
}

/** Digest of everything that can change a calculation's outcome. */
export function inputsDigest(db: Db, caseId: string): string {
  const c = one<{ tariff_id: string | null }>(db, 'SELECT tariff_id FROM cases WHERE id = ?', caseId);
  const tariff = c?.tariff_id
    ? one<Record<string, unknown>>(
        db,
        `SELECT version, currency, clock_trigger, free_days, include_trigger_day, include_end_day,
                exempt_weekends, exempt_closures, rate_tiers, closure_dates, effective_from, effective_to
         FROM tariffs WHERE id = ?`,
        c.tariff_id,
      )
    : null;
  const chargeLines = all(
    db,
    'SELECT service, billed_minor, period_start, period_end FROM charge_lines WHERE case_id = ? ORDER BY id',
    caseId,
  );
  const events = all(
    db,
    `SELECT type, local_date, supplier, record_id, revision, status
     FROM events WHERE case_id = ? AND status IN ('proven','disputed') ORDER BY type, local_date`,
    caseId,
  );
  const gaps = all(
    db,
    'SELECT required_event, plausible_from, plausible_to, status FROM gaps WHERE case_id = ? ORDER BY required_event',
    caseId,
  );
  return sha256Hex(
    canonicalJson({ charge_lines: chargeLines, tariff, events, gaps }),
  );
}

/**
 * Recompute the case calculation and persist a new revision.
 * Never fabricates a price: missing tariff coverage or unbounded events
 * yield explicit unpriced/missing_events statuses, not zero charges.
 */
export function recomputeCase(db: Db, caseId: string, computedBy: string | null): { revision: number; status: string } {
  const c = one<CaseRow & { currency: string }>(db, 'SELECT * FROM cases WHERE id = ?', caseId);
  if (!c) throw new Error(`case ${caseId} not found`);
  const billed =
    one<{ total: number | null }>(db, 'SELECT SUM(billed_minor) AS total FROM charge_lines WHERE case_id = ?', caseId)
      ?.total ?? 0;
  const digest = inputsDigest(db, caseId);
  const revision =
    (one<{ r: number }>(db, 'SELECT MAX(revision) AS r FROM calculations WHERE case_id = ?', caseId)?.r ?? 0) + 1;

  const finish = (status: string, body: {
    expected?: number | null; expectedMin?: number | null; expectedMax?: number | null;
    varMin?: number | null; varMax?: number | null; missing?: string[];
    breakdown?: unknown; tariffId?: string | null; tariffVersion?: string | null; currency?: string | null;
  }) => {
    db.prepare(
      `INSERT INTO calculations
       (id, case_id, revision, inputs_digest, tariff_id, tariff_version, currency, status,
        billed_minor, expected_minor, expected_min_minor, expected_max_minor,
        variance_min_minor, variance_max_minor, day_breakdown, missing, computed_at, computed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('calc'), caseId, revision, digest,
      body.tariffId ?? c.tariff_id ?? null, body.tariffVersion ?? null,
      body.currency ?? null, status, billed,
      body.expected ?? null, body.expectedMin ?? null, body.expectedMax ?? null,
      body.varMin ?? null, body.varMax ?? null,
      JSON.stringify(body.breakdown ?? null),
      body.missing ? JSON.stringify(body.missing) : null,
      isoNow(), computedBy,
    );
    refreshCaseState(db, caseId);
    return { revision, status };
  };

  // --- conflict check first: never auto-pick between contradictory records ---
  const openConflicts = all<{ kind: string }>(
    db, "SELECT kind FROM conflicts WHERE case_id = ? AND status = 'open' AND kind != 'invoice_revision'", caseId,
  );
  const tariff = c.tariff_id ? one<TariffRow>(db, 'SELECT * FROM tariffs WHERE id = ?', c.tariff_id) : null;
  if (!tariff) {
    return finish('unpriced', { missing: ['tariff'], breakdown: null });
  }

  const triggerType = tariff.clock_trigger;
  const usable = (type: string) =>
    all<EventRow>(
      db,
      `SELECT * FROM events WHERE case_id = ? AND type = ? AND status IN ('proven','disputed') ORDER BY local_date`,
      caseId, type,
    );

  const triggers = usable(triggerType);
  if (triggers.length === 0) {
    return finish('missing_events', {
      missing: [triggerType], tariffVersion: tariff.version, currency: tariff.currency, breakdown: null,
    });
  }
  const triggerDate = triggers[0].local_date;

  // Effective-range coverage: pinned tariff must govern the trigger date.
  if (triggerDate < tariff.effective_from || (tariff.effective_to && triggerDate > tariff.effective_to)) {
    return finish('unpriced', {
      missing: [`tariff coverage for ${triggerDate}`],
      tariffVersion: tariff.version, currency: tariff.currency, breakdown: null,
    });
  }

  const gateOuts = usable('gate_out');
  let gap = one<{ id: string; plausible_from: string | null; plausible_to: string | null; status: string }>(
    db, "SELECT * FROM gaps WHERE case_id = ? AND required_event = 'gate_out'", caseId,
  );
  // Absent required events materialize as visible gaps (INV-08).
  if (gateOuts.length === 0 && !gap) {
    const gapId = newId('gap');
    db.prepare(
      `INSERT INTO gaps (id, case_id, required_event, status, created_at) VALUES (?, ?, 'gate_out', 'open', ?)`,
    ).run(gapId, caseId, isoNow());
    gap = { id: gapId, plausible_from: null, plausible_to: null, status: 'open' };
  }

  // Candidate end dates.
  let candidates: { date: string; label: string }[] = [];
  let missing: string[] = [];
  if (gateOuts.length > 0) {
    candidates = gateOuts.map((e) => ({
      date: e.local_date,
      label: `${e.supplier}/${e.record_id}@${e.local_date}`,
    }));
  } else if (gap?.plausible_from && gap.plausible_to) {
    for (const d of eachDate(gap.plausible_from, gap.plausible_to)) {
      candidates.push({ date: d, label: `bounded-gap:${d}` });
    }
    missing = ['gate_out'];
  } else {
    missing = ['gate_out'];
    if (gap && gap.status === 'open') {
      db.prepare("UPDATE gaps SET status = 'unbounded' WHERE id = ?").run(gap.id);
    }
    return finish('missing_events', {
      missing, tariffVersion: tariff.version, currency: tariff.currency, breakdown: null,
    });
  }

  const scenarios: Scenario[] = candidates
    .filter((cd) => cd.date >= triggerDate)
    .map((cd) => {
      const { days, expected_minor } = computeDayLedger(tariff, triggerDate, cd.date);
      return { label: cd.label, gate_out_date: cd.date, days, expected_minor };
    });
  if (scenarios.length === 0) {
    return finish('unpriced', {
      missing: ['gate_out before trigger date'],
      tariffVersion: tariff.version, currency: tariff.currency, breakdown: null,
    });
  }

  const expectedMin = Math.min(...scenarios.map((s) => s.expected_minor));
  const expectedMax = Math.max(...scenarios.map((s) => s.expected_minor));
  const expected = scenarios.length === 1 ? scenarios[0].expected_minor : null;
  const varMin = billed - expectedMax;
  const varMax = billed - expectedMin;
  const hasConflict = openConflicts.length > 0 || gateOuts.length > 1;
  const status = hasConflict ? 'conflict' : missing.length > 0 ? 'bounded_estimate' : 'priced';

  // Keep the gap's uncertainty bounds in sync (INV-03: dispute != credit).
  if (gap) {
    db.prepare(
      'UPDATE gaps SET uncertainty_min_minor = ?, uncertainty_max_minor = ?, currency = ? WHERE id = ?',
    ).run(varMin, varMax, tariff.currency, gap.id);
  }

  return finish(status, {
    expected, expectedMin: expectedMin, expectedMax: expectedMax,
    varMin, varMax, missing: missing.length ? missing : undefined,
    tariffVersion: tariff.version, currency: tariff.currency,
    breakdown: { scenarios: scenarios.map((s) => ({ ...s, days: s.days })) },
  });
}

export function auditCalc(db: Db, tenantId: string, caseId: string, rev: number, actor?: string | null): void {
  audit(db, {
    tenantId, actor: actor ?? null, code: 'calculation_computed',
    detail: { case_id: caseId, revision: rev },
  });
}

/** Earliest plausible chargeable date given the pinned tariff and trigger date. */
export function firstChargeableDate(tariff: TariffRow, triggerDate: string): string {
  const freeSpan = tariff.free_days - (tariff.include_trigger_day ? 0 : 1);
  return addDays(triggerDate, Math.max(freeSpan, 0));
}
