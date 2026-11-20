import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { all, one, tx } from '../db.ts';
import { newId } from '../util/crypto.ts';
import { isDateString, isoNow } from '../util/dates.ts';
import { badRequest, conflict, notFound } from '../domain/errors.ts';
import { audit, type Actor } from '../domain/audit.ts';
import { recomputeCase } from '../domain/calc.ts';
import { invalidateApprovals } from '../domain/events.ts';

type Api = (method: string, path: string, fn: (ctx: import('../http/router.ts').RequestCtx, actor: Actor | null) => unknown, roles?: Actor['role'][]) => void;

export function registerTariffApi(api: Api, db: Db, _cfg: AppConfig): void {
  api('GET', '/tariffs', (ctx) => {
    const c = ctx as unknown as { query: URLSearchParams };
    const terminal = c.query.get('terminal_id');
    return terminal
      ? all(db, 'SELECT * FROM tariffs WHERE terminal_id = ? ORDER BY effective_from', terminal)
      : all(db, 'SELECT * FROM tariffs ORDER BY terminal_id, effective_from');
  });

  api('POST', '/tariffs', (ctx, actor) => {
    const body = JSON.parse((ctx as unknown as { rawBody: string }).rawBody || '{}');
    const required = ['terminal_id', 'version', 'currency', 'terminal_tz', 'clock_trigger', 'effective_from'];
    for (const k of required) {
      if (typeof body[k] !== 'string' || !body[k]) throw badRequest('bad_tariff', `${k} is required`);
    }
    if (!isDateString(body.effective_from)) throw badRequest('bad_tariff', 'effective_from must be YYYY-MM-DD');
    if (body.effective_to != null && !isDateString(body.effective_to)) {
      throw badRequest('bad_tariff', 'effective_to must be YYYY-MM-DD');
    }
    if (!Array.isArray(body.rate_tiers) || body.rate_tiers.length === 0) {
      throw badRequest('bad_tariff', 'rate_tiers must be a non-empty array of {from_day,to_day,rate_minor}');
    }
    for (const t of body.rate_tiers) {
      if (!Number.isInteger(t.from_day) || !Number.isInteger(t.rate_minor)) {
        throw badRequest('bad_tariff', 'each tier needs integer from_day and rate_minor');
      }
    }
    if (!Number.isInteger(body.free_days) || body.free_days < 0) {
      throw badRequest('bad_tariff', 'free_days must be a non-negative integer');
    }
    const id = newId('trf');
    tx(db, () => {
      const dup = one(
        db, 'SELECT id FROM tariffs WHERE tenant_id = ? AND terminal_id = ? AND version = ?',
        actor!.tenantId, body.terminal_id, body.version,
      );
      if (dup) throw conflict('tariff_version_exists', 'this terminal+version already exists');
      db.prepare(
        `INSERT INTO tariffs
         (id, tenant_id, terminal_id, version, currency, terminal_tz, clock_trigger, free_days,
          include_trigger_day, include_end_day, exempt_weekends, exempt_closures,
          rate_tiers, closure_dates, effective_from, effective_to, closure_calendar_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, actor!.tenantId, body.terminal_id, body.version, body.currency, body.terminal_tz,
        body.clock_trigger, body.free_days,
        body.include_trigger_day === false ? 0 : 1,
        body.include_end_day === false ? 0 : 1,
        body.exempt_weekends === true ? 1 : 0,
        body.exempt_closures === false ? 0 : 1,
        JSON.stringify(body.rate_tiers.map((t: { from_day: number; to_day?: number | null; rate_minor: number }) => ({
          from_day: t.from_day, to_day: t.to_day ?? null, rate_minor: t.rate_minor,
        }))),
        JSON.stringify(Array.isArray(body.closure_dates) ? body.closure_dates.filter(isDateString) : []),
        body.effective_from, body.effective_to ?? null, body.closure_calendar_hash ?? null,
        actor!.name, isoNow(),
      );
      audit(db, {
        tenantId: actor!.tenantId, actor: actor!.name, actorRole: actor!.role,
        code: 'tariff_created', detail: { tariff_id: id, terminal: body.terminal_id, version: body.version },
      });
    });
    return { tariff_id: id };
  }, ['manager']);

  api('PUT', '/cases/:id/tariff', (ctx, actor) => {
    const p = (ctx as unknown as { params: Record<string, string>; rawBody: string });
    const body = JSON.parse(p.rawBody || '{}');
    const caseId = p.params.id;
    return tx(db, () => {
      const c = one<{ tenant_id: string; terminal_id: string }>(
        db, 'SELECT tenant_id, terminal_id FROM cases WHERE id = ?', caseId,
      );
      if (!c || c.tenant_id !== actor!.tenantId) throw notFound('case_not_found', 'case not found');
      const t = one<{ id: string; terminal_id: string; version: string; tenant_id: string }>(
        db, 'SELECT id, terminal_id, version, tenant_id FROM tariffs WHERE id = ?', String(body.tariff_id ?? ''),
      );
      if (!t || t.tenant_id !== actor!.tenantId) throw notFound('tariff_not_found', 'tariff not found');
      if (t.terminal_id !== c.terminal_id) {
        throw badRequest('tariff_terminal_mismatch', `tariff is for ${t.terminal_id} but case is ${c.terminal_id}`);
      }
      db.prepare('UPDATE cases SET tariff_id = ?, tariff_version = ?, row_version = row_version + 1 WHERE id = ?')
        .run(t.id, t.version, caseId);
      audit(db, {
        tenantId: actor!.tenantId, actor: actor!.name, actorRole: actor!.role,
        code: 'tariff_pinned', detail: { case_id: caseId, tariff_id: t.id, version: t.version },
      });
      invalidateApprovals(db, caseId, 'tariff changed');
      const r = recomputeCase(db, caseId, actor!.name);
      return { case_id: caseId, tariff_id: t.id, tariff_version: t.version, calculation: r };
    });
  }, ['analyst']);
}
