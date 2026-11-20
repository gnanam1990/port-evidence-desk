import type { Db } from '../db.ts';
import { all, one, tx } from '../db.ts';
import { newId, sha256Hex } from '../util/crypto.ts';
import { isDateString, isOffsetString, localToUtc, isoNow } from '../util/dates.ts';
import { badRequest } from './errors.ts';
import { audit, type Actor } from './audit.ts';
import { recomputeCase } from './calc.ts';
import { refreshCaseState } from './state.ts';

export const EVENT_TYPES = new Set(['discharge', 'gate_out', 'gate_in', 'empty_return']);
export const PROVENANCES = new Set([
  'partner_signed', 'partner_authenticated', 'analyst_manual', 'pilot_fixture', 'synthetic',
]);

export interface EventInput {
  type: string;
  local_date: string;
  local_time?: string | null;
  utc_offset: string;
  supplier: string;
  record_id: string;
  revision?: number;
  provenance: string;
  container_ref?: string | null;
  voyage_ref?: string | null;
  terminal_id?: string | null;
  created_by?: string | null;
  detail?: unknown;
  raw?: string | null;
}

export interface IngestOutcome {
  event_id: string;
  outcome: 'accepted' | 'duplicate' | 'quarantined' | 'conflict' | 'stale_rejected';
  conflict_id?: string;
}

/** Mark any approved package stale; the digest check at export is the backstop. */
export function invalidateApprovals(db: Db, caseId: string, reason: string): void {
  const changed = db.prepare(
    "UPDATE packages SET status = 'stale' WHERE case_id = ? AND status = 'approved'",
  ).run(caseId).changes;
  if (changed > 0) {
    audit(db, {
      code: 'approval_invalidated', detail: { case_id: caseId, packages: changed, reason },
    });
  }
}

/**
 * Ingest one evidence record against a case. Enforces identity matching
 * (container/voyage/terminal), per-source dedup, revision handling and
 * append-only conflict semantics, then recomputes the case.
 */
export function ingestEvent(db: Db, caseId: string, input: EventInput): IngestOutcome {
  if (!EVENT_TYPES.has(input.type)) {
    throw badRequest('bad_event_type', `event type must be one of ${[...EVENT_TYPES].join(', ')}`);
  }
  if (!isDateString(input.local_date)) {
    throw badRequest('bad_event_date', 'local_date must be YYYY-MM-DD');
  }
  if (!isOffsetString(input.utc_offset)) {
    throw badRequest('bad_event_offset', 'utc_offset must look like +05:30');
  }
  if (!PROVENANCES.has(input.provenance)) {
    throw badRequest('bad_provenance', `provenance must be one of ${[...PROVENANCES].join(', ')}`);
  }
  const c = one<{ tenant_id: string; container_ref: string; voyage_ref: string; terminal_id: string }>(
    db, 'SELECT tenant_id, container_ref, voyage_ref, terminal_id FROM cases WHERE id = ?', caseId,
  );
  if (!c) throw badRequest('case_not_found', 'case not found');
  const revision = input.revision ?? 1;
  const raw = input.raw ?? JSON.stringify({
    type: input.type, local_date: input.local_date, local_time: input.local_time ?? null,
    utc_offset: input.utc_offset, supplier: input.supplier, record_id: input.record_id,
    revision, container_ref: input.container_ref, voyage_ref: input.voyage_ref,
    terminal_id: input.terminal_id,
  });
  const sourceDigest = sha256Hex(raw);
  const utc = localToUtc(input.local_date, input.local_time ?? null, input.utc_offset);

  return tx(db, () => {
    // Dedup / revision ordering within (supplier, record_id).
    const exact = one<{ id: string }>(
      db,
      'SELECT id FROM events WHERE case_id = ? AND supplier = ? AND record_id = ? AND revision = ?',
      caseId, input.supplier, input.record_id, revision,
    );
    if (exact) return { event_id: exact.id, outcome: 'duplicate' as const };

    const latestRev = one<{ maxr: number | null }>(
      db,
      'SELECT MAX(revision) AS maxr FROM events WHERE case_id = ? AND supplier = ? AND record_id = ?',
      caseId, input.supplier, input.record_id,
    )?.maxr ?? 0;
    if (revision < latestRev) {
      audit(db, {
        tenantId: c.tenant_id, code: 'event_stale_revision',
        detail: { case_id: caseId, record_id: input.record_id, revision, latest: latestRev },
      });
      return { event_id: '', outcome: 'stale_rejected' as const };
    }

    // Identity check: records naming a different container/voyage/terminal are quarantined.
    const mismatches: string[] = [];
    if (input.container_ref && input.container_ref !== c.container_ref) mismatches.push('container_ref');
    if (input.voyage_ref && input.voyage_ref !== c.voyage_ref) mismatches.push('voyage_ref');
    if (input.terminal_id && input.terminal_id !== c.terminal_id) mismatches.push('terminal_id');
    const eventId = newId('evt');
    const detailJson = JSON.stringify({
      ...(typeof input.detail === 'object' && input.detail !== null ? input.detail : {}),
      ...(mismatches.length ? { quarantine_reason: `identity mismatch: ${mismatches.join(',')}` } : {}),
    });
    const status = mismatches.length ? 'quarantined' : 'proven';
    db.prepare(
      `INSERT INTO events
       (id, case_id, type, local_date, local_time, utc_offset, utc_instant, supplier, record_id,
        revision, source_digest, provenance, status, detail, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId, caseId, input.type, input.local_date, input.local_time ?? null, input.utc_offset,
      utc, input.supplier, input.record_id, revision, sourceDigest, input.provenance, status,
      detailJson, input.created_by ?? null, isoNow(),
    );

    // Supersede older revisions of the same record (INV-05: original rows stay traceable).
    if (status === 'proven' && revision > 1) {
      db.prepare(
        `UPDATE events SET status = 'superseded'
         WHERE case_id = ? AND supplier = ? AND record_id = ? AND revision < ? AND status = 'proven'`,
      ).run(caseId, input.supplier, input.record_id, revision);
    }

    let outcome: IngestOutcome['outcome'] = status === 'quarantined' ? 'quarantined' : 'accepted';
    let conflictId: string | undefined;

    // Conflict detection: another usable record of the same type on a different date.
    if (status === 'proven') {
      const rival = one<{ id: string; local_date: string }>(
        db,
        `SELECT id, local_date FROM events
         WHERE case_id = ? AND type = ? AND status = 'proven' AND id != ? AND local_date != ?`,
        caseId, input.type, eventId, input.local_date,
      );
      if (rival) {
        conflictId = newId('cfl');
        db.prepare("UPDATE events SET status = 'disputed' WHERE id IN (?, ?)").run(rival.id, eventId);
        db.prepare(
          `INSERT INTO conflicts (id, case_id, kind, status, detail, created_at)
           VALUES (?, ?, 'event_time', 'open', ?, ?)`,
        ).run(
          conflictId, caseId,
          JSON.stringify({
            event_type: input.type,
            candidates: [rival.id, eventId],
            reason: 'two usable records disagree on the event date',
          }),
          isoNow(),
        );
        outcome = 'conflict';
      }
    }

    // A proven gate_out resolves the open gap for it.
    if (status === 'proven' && input.type === 'gate_out') {
      db.prepare(
        `UPDATE gaps SET status = 'resolved', resolved_at = ?, resolved_by = ?
         WHERE case_id = ? AND required_event = 'gate_out' AND status IN ('open','unbounded','ordered')`,
      ).run(isoNow(), input.created_by ?? 'system', caseId);
    }

    invalidateApprovals(db, caseId, `event ${input.record_id} rev ${revision} (${outcome})`);
    recomputeCase(db, caseId, input.created_by ?? null);
    refreshCaseState(db, caseId);
    audit(db, {
      tenantId: c.tenant_id, code: `event_${outcome}`,
      detail: { case_id: caseId, event_id: eventId, type: input.type, outcome },
      externalRef: `${input.supplier}/${input.record_id}@${revision}`,
    });
    return { event_id: eventId, outcome, conflict_id: conflictId };
  });
}

/** Manual conflict resolution with an explicit reason trail (T-010). */
export function resolveEventConflict(
  db: Db,
  args: { actor: Actor; conflictId: string; winnerEventId: string; reason: string },
): { case_id: string } {
  const { actor } = args;
  if (!args.reason.trim()) throw badRequest('reason_required', 'a resolution reason is required');
  return tx(db, () => {
    const c = one<{ id: string; case_id: string; detail: string }>(
      db,
      `SELECT cf.id, cf.case_id, cf.detail FROM conflicts cf JOIN cases cs ON cs.id = cf.case_id
       WHERE cf.id = ? AND cs.tenant_id = ? AND cf.kind = 'event_time' AND cf.status = 'open'`,
      args.conflictId, actor.tenantId,
    );
    if (!c) throw badRequest('conflict_not_found', 'no open event-time conflict for this tenant');
    const detail = JSON.parse(c.detail) as { candidates: string[] };
    if (!detail.candidates.includes(args.winnerEventId)) {
      throw badRequest('winner_not_candidate', 'winner must be one of the conflicting event ids');
    }
    db.prepare("UPDATE events SET status = 'proven' WHERE id = ?").run(args.winnerEventId);
    for (const other of detail.candidates) {
      if (other !== args.winnerEventId) {
        db.prepare("UPDATE events SET status = 'superseded' WHERE id = ?").run(other);
      }
    }
    db.prepare(
      `UPDATE conflicts SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_reason = ?, winner_event_id = ?
       WHERE id = ?`,
    ).run(actor.name, isoNow(), args.reason, args.winnerEventId, c.id);
    const event = one<{ type: string }>(db, 'SELECT type FROM events WHERE id = ?', args.winnerEventId);
    if (event?.type === 'gate_out') {
      db.prepare(
        `UPDATE gaps SET status = 'resolved', resolved_at = ?, resolved_by = ?
         WHERE case_id = ? AND required_event = 'gate_out' AND status IN ('open','unbounded','ordered')`,
      ).run(isoNow(), actor.name, c.case_id);
    }
    invalidateApprovals(db, c.case_id, `conflict ${args.conflictId} resolved`);
    recomputeCase(db, c.case_id, actor.name);
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'event_conflict_resolved',
      detail: { case_id: c.case_id, conflict: c.id, winner: args.winnerEventId, reason: args.reason },
    });
    return { case_id: c.case_id };
  });
}
