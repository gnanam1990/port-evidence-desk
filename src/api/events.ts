import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { one, tx } from '../db.ts';
import { newId } from '../util/crypto.ts';
import { isDateString, isoNow } from '../util/dates.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import { type Actor } from '../domain/audit.ts';
import { ingestEvent, resolveEventConflict, invalidateApprovals } from '../domain/events.ts';
import { recomputeCase } from '../domain/calc.ts';

type Api = (method: string, path: string, fn: (ctx: import('../http/router.ts').RequestCtx, actor: Actor | null) => unknown, roles?: Actor['role'][]) => void;

export function registerEventApi(api: Api, db: Db, _cfg: AppConfig): void {
  api('POST', '/cases/:id/events', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; rawBody: string };
    const body = JSON.parse(p.rawBody || '{}');
    const caseId = p.params.id;
    const cs = one<{ tenant_id: string }>(db, 'SELECT tenant_id FROM cases WHERE id = ?', caseId);
    if (!cs || cs.tenant_id !== actor!.tenantId) throw notFound('case_not_found', 'case not found');
    const res = ingestEvent(db, caseId, {
      type: String(body.type ?? ''),
      local_date: String(body.local_date ?? ''),
      local_time: body.local_time ?? null,
      utc_offset: String(body.utc_offset ?? '+00:00'),
      supplier: typeof body.supplier === 'string' && body.supplier ? body.supplier : 'analyst',
      record_id: typeof body.record_id === 'string' && body.record_id
        ? body.record_id
        : `manual-${Date.now()}`,
      revision: Number.isInteger(body.revision) ? body.revision : 1,
      provenance: 'analyst_manual',
      container_ref: body.container_ref ?? null,
      voyage_ref: body.voyage_ref ?? null,
      terminal_id: body.terminal_id ?? null,
      created_by: actor!.name,
      detail: { entered_via: 'casebook' },
    });
    return res;
  }, ['analyst']);

  // Create or adjust the bounded plausible range of a gap.
  api('POST', '/cases/:id/gaps', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; rawBody: string };
    const body = JSON.parse(p.rawBody || '{}');
    const caseId = p.params.id;
    const cs = one<{ tenant_id: string }>(db, 'SELECT tenant_id FROM cases WHERE id = ?', caseId);
    if (!cs || cs.tenant_id !== actor!.tenantId) throw notFound('case_not_found', 'case not found');
    const required = String(body.required_event ?? 'gate_out');
    const from = body.plausible_from ?? null;
    const to = body.plausible_to ?? null;
    if (from !== null && !isDateString(from)) throw badRequest('bad_bound', 'plausible_from must be YYYY-MM-DD');
    if (to !== null && !isDateString(to)) throw badRequest('bad_bound', 'plausible_to must be YYYY-MM-DD');
    if (from && to && to < from) throw badRequest('bad_bound', 'plausible_to precedes plausible_from');
    return tx(db, () => {
      const existing = one<{ id: string; status: string }>(
        db, 'SELECT id, status FROM gaps WHERE case_id = ? AND required_event = ?', caseId, required,
      );
      let gapId: string;
      if (existing) {
        if (existing.status === 'resolved') {
          throw badRequest('gap_resolved', 'this gap is already resolved by a proven record');
        }
        db.prepare(
          `UPDATE gaps SET plausible_from = ?, plausible_to = ?, bound_reason = ?, status = 'open' WHERE id = ?`,
        ).run(from, to, String(body.bound_reason ?? ''), existing.id);
        gapId = existing.id;
      } else {
        gapId = newId('gap');
        db.prepare(
          `INSERT INTO gaps (id, case_id, required_event, plausible_from, plausible_to, bound_reason, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        ).run(gapId, caseId, required, from, to, String(body.bound_reason ?? ''), isoNow());
      }
      invalidateApprovals(db, caseId, 'gap bounds changed');
      const calc = recomputeCase(db, caseId, actor!.name);
      return { gap_id: gapId, calculation: calc };
    });
  }, ['analyst']);

  api('POST', '/conflicts/:id/resolve-event', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; rawBody: string };
    const body = JSON.parse(p.rawBody || '{}');
    return resolveEventConflict(db, {
      actor: actor!,
      conflictId: p.params.id,
      winnerEventId: String(body.winner_event_id ?? ''),
      reason: String(body.reason ?? ''),
    });
  }, ['analyst', 'manager']);

  api('GET', '/cases/:id/estimate', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string> };
    const calc = one(
      db, 'SELECT * FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1', p.params.id,
    );
    if (!calc) throw notFound('no_calculation', 'no calculation exists yet; pin a tariff and post events');
    return calc;
  });

  api('POST', '/cases/:id/estimate', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string> };
    const cs = one<{ tenant_id: string }>(db, 'SELECT tenant_id FROM cases WHERE id = ?', p.params.id);
    if (!cs || cs.tenant_id !== actor!.tenantId) throw notFound('case_not_found', 'case not found');
    const r = recomputeCase(db, p.params.id, actor!.name);
    return one(
      db, 'SELECT * FROM calculations WHERE case_id = ? AND revision = ?', p.params.id, r.revision,
    );
  }, ['analyst']);
}
