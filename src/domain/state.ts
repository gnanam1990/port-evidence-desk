import type { Db } from '../db.ts';
import { one } from '../db.ts';

/**
 * Derive the case workflow state from persisted facts.
 * Ladder (TDD): open → tariff_confirmed → evidence_gap | computable →
 * evidence_authorized → awaiting_partner → analyst_review →
 * package_approved → exported; accounting overlays → partially_credited |
 * credited; conflict_review and pending_reconciliation override.
 */
export function deriveCaseState(db: Db, caseId: string): string {
  const c = one<{ tariff_id: string | null }>(
    db, 'SELECT tariff_id FROM cases WHERE id = ?', caseId,
  );
  if (!c) return 'open';

  const openConflicts = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM conflicts WHERE case_id = ? AND status = 'open'", caseId,
  )!.n;
  if (openConflicts > 0) return 'conflict_review';

  const pendingRecon = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM evidence_orders WHERE case_id = ? AND status = 'pending_reconciliation'", caseId,
  )!.n;
  if (pendingRecon > 0) return 'pending_reconciliation';

  // Accounting overlay: credits are terminal accounting facts.
  const credited = one<{ t: number | null }>(
    db, 'SELECT SUM(amount_minor) AS t FROM credits WHERE case_id = ?', caseId,
  )?.t ?? 0;
  const latestCalc = one<{ variance_max_minor: number | null; expected_minor: number | null }>(
    db, 'SELECT variance_max_minor, expected_minor FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1', caseId,
  );
  if ((credited ?? 0) > 0) {
    const target = latestCalc?.variance_max_minor ?? latestCalc?.expected_minor ?? 0;
    return target > 0 && credited! >= target ? 'credited' : 'partially_credited';
  }

  const exportedPkg = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM packages WHERE case_id = ? AND status = 'exported'", caseId,
  )!.n;
  if (exportedPkg > 0) return 'exported';

  const approvedPkg = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM packages WHERE case_id = ? AND status = 'approved'", caseId,
  )!.n;
  if (approvedPkg > 0) return 'package_approved';

  const awaiting = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM evidence_orders WHERE case_id = ? AND status IN ('dispatch_pending','awaiting_delivery')", caseId,
  )!.n;
  if (awaiting > 0) return 'awaiting_partner';

  const delivered = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM evidence_orders WHERE case_id = ? AND status = 'delivered'", caseId,
  )!.n;

  const calc = latestCalc !== undefined;
  if (calc || delivered > 0) {
    const hasOpenGap = one<{ n: number }>(
      db, "SELECT COUNT(*) AS n FROM gaps WHERE case_id = ? AND status IN ('open','unbounded','ordered')", caseId,
    )!.n;
    if (hasOpenGap === 0) return 'analyst_review';
  }

  const authorized = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM evidence_orders WHERE case_id = ? AND status = 'authorized'", caseId,
  )!.n;
  if (authorized > 0) return 'evidence_authorized';

  if (!c.tariff_id) return 'open';
  const provenPair = one<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM events WHERE case_id = ? AND status = 'proven'
         AND type IN ('discharge','gate_out') GROUP BY case_id HAVING COUNT(DISTINCT type) = 2`, caseId,
  );
  if (provenPair) return 'computable';
  const openGap = one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM gaps WHERE case_id = ? AND status IN ('open','unbounded')", caseId,
  )!.n;
  return openGap > 0 ? 'evidence_gap' : 'tariff_confirmed';
}

export function refreshCaseState(db: Db, caseId: string): string {
  const next = deriveCaseState(db, caseId);
  db.prepare('UPDATE cases SET state = ?, row_version = row_version + 1 WHERE id = ?').run(next, caseId);
  return next;
}
