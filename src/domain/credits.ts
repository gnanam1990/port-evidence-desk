import type { Db } from '../db.ts';
import { all, one, tx } from '../db.ts';
import { newId } from '../util/crypto.ts';
import { isDateString, isoNow } from '../util/dates.ts';
import { badRequest, notFound, unprocessable } from './errors.ts';
import { audit, type Actor } from './audit.ts';
import { refreshCaseState } from './state.ts';

/**
 * Record a carrier-issued credit against a case (FR-07 / INV-07).
 * Duplicate references never double-count; currency must match the case.
 */
export function postCredit(
  db: Db,
  args: {
    actor: Actor; caseId: string; reference: string; amountMinor: number;
    currency: string; effectiveOn: string; chargeLineId?: string | null; source?: string;
  },
): { credit_id: string; deduplicated: boolean; recovered_total_minor: number } {
  const { actor } = args;
  return tx(db, () => {
    const c = one<{ tenant_id: string; currency: string }>(
      db, 'SELECT tenant_id, currency FROM cases WHERE id = ?', args.caseId,
    );
    if (!c || c.tenant_id !== actor.tenantId) throw notFound('case_not_found', 'case not found');
    if (args.currency !== c.currency) {
      throw unprocessable('currency_mismatch', `credit is ${args.currency} but case is ${c.currency}; attach a converted statement instead`);
    }
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
      throw badRequest('bad_amount', 'credit amount must be a positive minor-unit integer');
    }
    if (!isDateString(args.effectiveOn)) {
      throw badRequest('bad_date', 'effective_on must be YYYY-MM-DD');
    }
    if (!args.reference.trim()) {
      throw badRequest('bad_reference', 'a carrier credit reference is required');
    }
    const existing = one<{ id: string }>(
      db, 'SELECT id FROM credits WHERE tenant_id = ? AND reference = ?',
      actor.tenantId, args.reference,
    );
    const total = () =>
      one<{ t: number | null }>(db, 'SELECT SUM(amount_minor) AS t FROM credits WHERE case_id = ?', args.caseId)?.t ?? 0;
    if (existing) {
      return { credit_id: existing.id, deduplicated: true, recovered_total_minor: total() };
    }
    const id = newId('crd');
    db.prepare(
      `INSERT INTO credits (id, tenant_id, case_id, charge_line_id, reference, amount_minor, currency, effective_on, source, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, actor.tenantId, args.caseId, args.chargeLineId ?? null, args.reference,
      args.amountMinor, args.currency, args.effectiveOn, args.source ?? 'carrier_credit',
      actor.name, isoNow(),
    );
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'credit_posted',
      detail: { credit_id: id, case_id: args.caseId, amount_minor: args.amountMinor, reference: args.reference },
      externalRef: args.reference,
    });
    refreshCaseState(db, args.caseId);
    return { credit_id: id, deduplicated: false, recovered_total_minor: total() };
  });
}

/**
 * Portfolio rollup: disputed (max potential variance on active cases),
 * submitted (variance covered by exported packages) and credited (actual
 * recovered cash) as separate per-currency subtotals (INV-03, INV-07).
 */
export function portfolioReport(db: Db, tenantId: string) {
  const cases = all<{ id: string; currency: string; state: string }>(
    db, 'SELECT id, currency, state FROM cases WHERE tenant_id = ?', tenantId,
  );
  const byCcy = new Map<string, { disputed: number; submitted: number; credited: number; cases: number }>();
  for (const c of cases) {
    const bucket = byCcy.get(c.currency) ?? { disputed: 0, submitted: 0, credited: 0, cases: 0 };
    bucket.cases += 1;
    const calc = one<{ variance_max_minor: number | null; status: string }>(
      db, 'SELECT variance_max_minor, status FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1', c.id,
    );
    const active = !['exported', 'credited'].includes(c.state);
    if (active && calc && ['priced', 'bounded_estimate', 'conflict'].includes(calc.status)) {
      bucket.disputed += calc.variance_max_minor ?? 0;
    }
    const exported = one<{ inputs_digest: string; calculation_id: string }>(
      db, "SELECT inputs_digest, calculation_id FROM packages WHERE case_id = ? AND status = 'exported' ORDER BY exported_at DESC LIMIT 1", c.id,
    );
    if (exported) {
      const ecalc = one<{ variance_max_minor: number | null }>(
        db, 'SELECT variance_max_minor FROM calculations WHERE id = ?', exported.calculation_id,
      );
      bucket.submitted += ecalc?.variance_max_minor ?? 0;
    }
    const cred = one<{ t: number | null }>(
      db, 'SELECT SUM(amount_minor) AS t FROM credits WHERE case_id = ?', c.id,
    );
    bucket.credited += cred?.t ?? 0;
    byCcy.set(c.currency, bucket);
  }
  return {
    tenant_id: tenantId,
    generated_at: isoNow(),
    totals: [...byCcy.entries()].map(([currency, b]) => ({
      currency,
      disputed_minor: b.disputed,
      submitted_minor: b.submitted,
      credited_minor: b.credited,
      case_count: b.cases,
    })),
  };
}
