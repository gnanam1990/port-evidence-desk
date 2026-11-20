import type { Db } from '../db.ts';
import { one, tx } from '../db.ts';
import { newId, sha256Hex, hmacSha256Hex, safeEqualHex } from '../util/crypto.ts';
import { isoNow } from '../util/dates.ts';
import { audit } from './audit.ts';
import { ingestEvent } from './events.ts';
import { refreshCaseState } from './state.ts';
import { adapterFor, type PartnerRow, type OrderRow } from '../adapters/provider.ts';

export interface CallbackResult {
  callback_id: string;
  outcome: string;
  event_id?: string;
  conflict_id?: string;
  order_id?: string;
}

/**
 * Process one authenticated partner callback end to end:
 * signature verify → dedup → bind to order → identity check → append/supersede
 * → recompute. Every callback is persisted exactly once per
 * (partner, record_id, revision) so replays converge.
 */
export function processPartnerCallback(
  db: Db,
  args: { partner: PartnerRow; body: string; signature: string | null },
): CallbackResult {
  const { partner, body } = args;
  const digest = sha256Hex(body);

  let parsed: Record<string, unknown> = {};
  let parseError = false;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    parseError = true;
  }
  const recordId = typeof parsed.record_id === 'string' && parsed.record_id
    ? parsed.record_id
    : `unparsed-${digest.slice(0, 12)}`;
  const revision = Number.isInteger(parsed.revision) ? (parsed.revision as number) : 1;

  const expected = hmacSha256Hex(partner.callback_secret, body);
  const signatureOk = typeof args.signature === 'string' && safeEqualHex(args.signature, expected);

  return tx(db, () => {
    const dup = one<{ id: string; outcome: string }>(
      db,
      'SELECT id, outcome FROM partner_callbacks WHERE partner_id = ? AND record_id = ? AND revision = ?',
      partner.id, recordId, revision,
    );
    if (dup) return { callback_id: dup.id, outcome: 'duplicate' };

    const callbackId = newId('pcb');
    const record = (outcome: string, orderRef: string | null) => {
      db.prepare(
        `INSERT INTO partner_callbacks (id, partner_id, order_ref, record_id, revision, signature_ok, outcome, body_digest, body, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(callbackId, partner.id, orderRef, recordId, revision, signatureOk ? 1 : 0, outcome, digest, body, isoNow());
      audit(db, {
        tenantId: partner.tenant_id, code: `callback_${outcome}`,
        detail: { callback_id: callbackId, partner: partner.id, record_id: recordId, revision },
        externalRef: orderRef,
      });
    };

    if (!signatureOk) {
      record('rejected', null);
      return { callback_id: callbackId, outcome: 'signature_rejected' };
    }
    if (parseError) {
      record('rejected', null);
      return { callback_id: callbackId, outcome: 'unparseable' };
    }

    const orderRef = typeof parsed.order_ref === 'string' ? parsed.order_ref : null;
    const order = orderRef
      ? one<OrderRow & { case_id: string }>(db, 'SELECT * FROM evidence_orders WHERE vendor_ref = ?', orderRef)
      : undefined;
    if (!order) {
      record('parked_unknown_order', orderRef);
      return { callback_id: callbackId, outcome: 'parked_unknown_order' };
    }

    const ev = parsed.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev.type !== 'string' || typeof ev.local_date !== 'string' || typeof ev.utc_offset !== 'string') {
      record('rejected', orderRef);
      return { callback_id: callbackId, outcome: 'bad_event_payload' };
    }

    const res = ingestEvent(db, order.case_id, {
      type: ev.type,
      local_date: ev.local_date,
      local_time: typeof ev.local_time === 'string' ? ev.local_time : null,
      utc_offset: ev.utc_offset,
      supplier: partner.id,
      record_id: recordId,
      revision,
      provenance: 'partner_signed',
      container_ref: typeof parsed.container_ref === 'string' ? parsed.container_ref : null,
      voyage_ref: typeof parsed.voyage_ref === 'string' ? parsed.voyage_ref : null,
      terminal_id: typeof parsed.terminal_id === 'string' ? parsed.terminal_id : null,
      created_by: `partner:${partner.id}`,
      detail: { callback_id: callbackId, order_ref: orderRef, license: parsed.license ?? null },
      raw: body,
    });

    const outcome =
      res.outcome === 'accepted' ? 'accepted'
      : res.outcome === 'quarantined' ? 'quarantined'
      : res.outcome === 'conflict' ? 'conflict'
      : res.outcome === 'stale_rejected' ? 'rejected'
      : res.outcome;

    if (['accepted', 'conflict', 'quarantined'].includes(outcome)) {
      if (order.status === 'awaiting_delivery' || order.status === 'dispatch_pending' || order.status === 'authorized') {
        db.prepare("UPDATE evidence_orders SET status = 'delivered', delivered_at = ? WHERE id = ?")
          .run(isoNow(), order.id);
      }
      refreshCaseState(db, order.case_id);
    }
    record(outcome, orderRef);
    return { callback_id: callbackId, outcome, event_id: res.event_id || undefined, conflict_id: res.conflict_id, order_id: order.id };
  });
}

/**
 * Dispatch one authorized order through its rail adapter.
 * Persists the intent outcome; callers (worker) own retry policy.
 * Unknown outcome → pending_reconciliation and automatic redispatch stops.
 */
export function dispatchOrder(db: Db, orderId: string): { ok: boolean; status: string } {
  return tx(db, () => {
    const order = one<OrderRow & { quote_id: string }>(
      db, 'SELECT * FROM evidence_orders WHERE id = ?', orderId,
    );
    if (!order) throw new Error(`order ${orderId} not found`);
    if (!['authorized', 'dispatch_pending'].includes(order.status)) {
      return { ok: true, status: order.status };
    }
    db.prepare("UPDATE evidence_orders SET status = 'dispatch_pending' WHERE id = ?").run(orderId);
    const partner = one<PartnerRow>(
      db,
      `SELECT p.* FROM partners p JOIN quotes q ON q.partner_id = p.id WHERE q.id = ?`,
      order.quote_id,
    );
    if (!partner) throw new Error(`order ${orderId} has no resolvable partner`);
    const adapter = adapterFor(order.rail);
    if (!adapter) {
      db.prepare(
        "UPDATE evidence_orders SET status = 'pending_reconciliation', failure_reason = ? WHERE id = ?",
      ).run(`no adapter for rail ${order.rail}`, orderId);
      return { ok: false, status: 'pending_reconciliation' };
    }
    const res = adapter.dispatch(db, order, partner);
    if (res.ok) {
      audit(db, {
        tenantId: order.tenant_id,
        code: 'order_dispatched', detail: { order_id: orderId, rail: order.rail }, externalRef: order.vendor_ref,
      });
      refreshCaseState(db, order.case_id);
      return { ok: true, status: res.orderStatus ?? 'awaiting_delivery' };
    }
    if (res.failureReason === 'provider_capability_blocked') {
      db.prepare(
        "UPDATE evidence_orders SET status = 'blocked_external', failure_reason = ? WHERE id = ?",
      ).run(res.detail ?? res.failureReason, orderId);
      audit(db, {
        tenantId: partner.tenant_id, code: 'order_blocked_external',
        detail: { order_id: orderId, rail: order.rail, reason: res.detail }, externalRef: order.vendor_ref,
      });
      refreshCaseState(db, order.case_id);
      return { ok: false, status: 'blocked_external' };
    }
    // Ambiguous outcome: stop automatic redispatch, flag for reconciliation.
    db.prepare(
      "UPDATE evidence_orders SET status = 'pending_reconciliation', failure_reason = ? WHERE id = ?",
    ).run(res.detail ?? res.failureReason ?? 'unknown', orderId);
    audit(db, {
      tenantId: partner.tenant_id, code: 'order_pending_reconciliation',
      detail: { order_id: orderId, rail: order.rail, reason: res.detail }, externalRef: order.vendor_ref,
    });
    refreshCaseState(db, order.case_id);
    return { ok: false, status: 'pending_reconciliation' };
  });
}
