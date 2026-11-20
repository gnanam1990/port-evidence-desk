import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { all } from '../db.ts';
import { isoNow } from '../util/dates.ts';
import { type Actor } from '../domain/audit.ts';

type Api = (method: string, path: string, fn: (ctx: import('../http/router.ts').RequestCtx, actor: Actor | null) => unknown, roles?: Actor['role'][]) => void;

/**
 * Operator status ledger: stalled work, parked callbacks, blocked external
 * capability and open conflicts. Persisted facts only — identical before and
 * after a process restart (INV-08).
 */
export function registerOpsApi(api: Api, db: Db, _cfg: AppConfig): void {
  api('GET', '/ops/status', (_ctx, actor) => {
    const t = actor!.tenantId;
    return {
      generated_at: isoNow(),
      tenant_id: t,
      outbox: all(
        db,
        `SELECT id, kind, status, attempts, last_error, created_at FROM outbox
         WHERE status IN ('pending','processing','failed') ORDER BY created_at`,
      ),
      orders_attention: all(
        db,
        `SELECT id, case_id, rail, status, failure_reason, vendor_ref, authorized_at
         FROM evidence_orders WHERE tenant_id = ? AND status IN ('pending_reconciliation','blocked_external','awaiting_delivery')`,
        t,
      ),
      parked_callbacks: all(
        db,
        `SELECT pc.id, pc.partner_id, pc.order_ref, pc.record_id, pc.outcome, pc.received_at
         FROM partner_callbacks pc JOIN partners p ON p.id = pc.partner_id
         WHERE p.tenant_id = ? AND pc.outcome IN ('parked_unknown_order','rejected')`,
        t,
      ),
      open_conflicts: all(
        db,
        `SELECT cf.id, cf.case_id, cf.kind, cf.detail, cf.created_at FROM conflicts cf
         JOIN cases cs ON cs.id = cf.case_id WHERE cs.tenant_id = ? AND cf.status = 'open'`,
        t,
      ),
      capability_ledger: all(
        db,
        `SELECT id, name, capabilities, status FROM partners WHERE tenant_id = ?`,
        t,
      ).map((p) => {
        const row = p as { capabilities: string };
        return { ...row, capabilities: JSON.parse(row.capabilities) };
      }),
      stale_operations: all(
        db,
        `SELECT id, kind, actor, created_at FROM operations WHERE status = 'running'`,
      ),
    };
  }, ['analyst', 'manager', 'operator', 'accounts']);
}
