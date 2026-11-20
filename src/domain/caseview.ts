import type { Db } from '../db.ts';
import { all, one } from '../db.ts';
import { notFound } from './errors.ts';
import type { Actor } from './audit.ts';

/**
 * Full casebook projection shared by the JSON API and the HTML casebook.
 * Potential dispute lives on `latest_calculation`; received credit is a
 * separate `recovered_minor` field (INV-03).
 */
export function caseDetail(db: Db, caseId: string, actor: Actor) {
  const c = one<Record<string, unknown>>(
    db,
    'SELECT * FROM cases WHERE id = ? AND tenant_id = ?',
    caseId,
    actor.tenantId,
  );
  if (!c) throw notFound('case_not_found', 'case not found');
  const chargeLines = all(db, 'SELECT * FROM charge_lines WHERE case_id = ?', caseId);
  const docs = all(
    db,
    'SELECT id, revision, source_digest, filename, format, received_by, received_at, status, provenance FROM invoice_documents WHERE case_id = ? ORDER BY revision',
    caseId,
  );
  const events = all(
    db,
    `SELECT id, type, local_date, local_time, utc_offset, utc_instant, supplier, record_id, revision, source_digest, provenance, status, created_at
     FROM events WHERE case_id = ? ORDER BY local_date, utc_instant`,
    caseId,
  );
  const gaps = all(db, 'SELECT * FROM gaps WHERE case_id = ?', caseId);
  const calculation = one(
    db,
    'SELECT * FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1',
    caseId,
  );
  const conflicts = all(db, "SELECT * FROM conflicts WHERE case_id = ? AND status = 'open'", caseId);
  const credits = all(db, 'SELECT * FROM credits WHERE case_id = ?', caseId);
  const orders = all(db, 'SELECT * FROM evidence_orders WHERE case_id = ?', caseId);
  const packages = all(db, 'SELECT * FROM packages WHERE case_id = ?', caseId);
  const recovered = one<{ t: number | null }>(
    db, 'SELECT SUM(amount_minor) AS t FROM credits WHERE case_id = ?', caseId,
  );
  return {
    ...c,
    recovered_minor: recovered?.t ?? 0,
    charge_lines: chargeLines,
    invoice_documents: docs,
    events,
    gaps,
    latest_calculation: calculation ?? null,
    open_conflicts: conflicts,
    credits,
    evidence_orders: orders,
    packages,
  };
}
