import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import type { Router, RequestCtx } from '../http/router.ts';
import { one, tx } from '../db.ts';
import { isoNow } from '../util/dates.ts';
import { badRequest, notFound, unauthorized } from '../domain/errors.ts';
import { audit } from '../domain/audit.ts';
import { processPartnerCallback } from '../domain/reconcile.ts';
import type { PartnerRow } from '../adapters/provider.ts';
import { actorFromRequest, requireRole } from '../http/auth.ts';
import { hmacSha256Hex } from '../util/crypto.ts';

/**
 * Partner-facing endpoints. Callback authentication is the HMAC signature on
 * the raw body — no browser session. Rejects are still recorded for the audit.
 */
export function registerPartnerApi(router: Router, db: Db, _cfg: AppConfig): void {
  router.add('POST', '/partners/:id/events', async (ctx: RequestCtx) => {
    const partner = one<PartnerRow>(db, 'SELECT * FROM partners WHERE id = ?', ctx.params.id);
    if (!partner) throw notFound('partner_not_found', 'partner not found');
    const signature =
      (ctx.headers['x-ped-signature'] as string | undefined) ??
      (ctx.headers['x-signature'] as string | undefined) ??
      null;
    const res = processPartnerCallback(db, { partner, body: ctx.rawBody, signature });
    if (res.outcome === 'signature_rejected') throw unauthorized('bad partner signature');
    return res;
  });

  // Selective retry of a parked or rejected callback (FR-05), session-authed.
  router.add('POST', '/callbacks/:id/retry', async (ctx: RequestCtx) => {
    const actor = actorFromRequest(db, ctx.headers);
    requireRole(actor, 'analyst', 'manager');
    const cb = one<{ id: string; partner_id: string; outcome: string; body: string }>(
      db,
      `SELECT pc.id, pc.partner_id, pc.outcome, pc.body FROM partner_callbacks pc
       JOIN partners p ON p.id = pc.partner_id WHERE pc.id = ? AND p.tenant_id = ?`,
      ctx.params.id, actor.tenantId,
    );
    if (!cb) throw notFound('callback_not_found', 'callback not found');
    if (!['parked_unknown_order', 'rejected'].includes(cb.outcome)) {
      throw badRequest('not_retryable', `callback outcome ${cb.outcome} is not retryable`);
    }
    const partner = one<PartnerRow>(db, 'SELECT * FROM partners WHERE id = ?', cb.partner_id)!;
    // Re-derive the signature so a previously-parked valid callback can bind now.
    const signature = hmacSha256Hex(partner.callback_secret, cb.body);
    tx(db, () => {
      db.prepare('DELETE FROM partner_callbacks WHERE id = ?').run(cb.id);
    });
    const res = processPartnerCallback(db, { partner, body: cb.body, signature });
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'callback_retried', detail: { original_callback: cb.id, new_callback: res.callback_id, outcome: res.outcome },
    });
    return res;
  });
}
