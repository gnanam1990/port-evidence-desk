import type { Db } from '../db.ts';
import { one } from '../db.ts';
import { newId, hmacSha256Hex } from '../util/crypto.ts';
import { isoNow } from '../util/dates.ts';

export interface PartnerRow {
  id: string;
  tenant_id: string;
  name: string;
  endpoint: string | null;
  service_id: string | null;
  network: string | null;
  asset: string | null;
  callback_secret: string;
  capabilities: string;
  status: string;
}

export interface OrderRow {
  id: string;
  tenant_id: string;
  case_id: string;
  gap_id: string;
  rail: string;
  vendor_ref: string;
  status: string;
}

export interface DispatchResult {
  ok: boolean;
  orderStatus?: string;
  failureReason?: string;
  detail?: string;
}

export interface Adapter {
  rail: string;
  dispatch(db: Db, order: OrderRow, partner: PartnerRow): DispatchResult;
}

/**
 * Team-controlled fake merchant for the local business workflow
 * (KITE-AND-PROVIDERS: explicitly labeled, never a live settlement).
 * Delivers the earliest plausible gate-out date as a signed callback so the
 * whole authenticated-callback path is exercised without egress.
 */
const localDemoAdapter: Adapter = {
  rail: 'local_demo',
  dispatch(db, order, partner) {
    const caps = JSON.parse(partner.capabilities) as Record<string, unknown>;
    if (caps.execute !== 'local_demo') {
      return { ok: false, failureReason: 'adapter_not_executable', detail: `execute=${caps.execute}` };
    }
    db.prepare(
      "UPDATE evidence_orders SET status = 'awaiting_delivery', paid = 1, dispatched_at = ? WHERE id = ?",
    ).run(isoNow(), order.id);
    if (caps.auto_callback === true) {
      const gap = one<{ plausible_from: string | null; case_id: string }>(
        db, 'SELECT plausible_from, case_id FROM gaps WHERE id = ?', order.gap_id,
      );
      const cs = one<{ container_ref: string; voyage_ref: string; terminal_id: string }>(
        db, 'SELECT container_ref, voyage_ref, terminal_id FROM cases WHERE id = ?', order.case_id,
      );
      if (gap?.plausible_from && cs) {
        const record = {
          order_ref: order.vendor_ref,
          record_id: `demo-${order.id}`,
          revision: 1,
          event: { type: 'gate_out', local_date: gap.plausible_from, utc_offset: '+05:30' },
          container_ref: cs.container_ref,
          voyage_ref: cs.voyage_ref,
          terminal_id: cs.terminal_id,
          license: 'partner_quote_terms',
        };
        const body = JSON.stringify(record);
        db.prepare(
          `INSERT INTO outbox (id, kind, payload, created_at)
           VALUES (?, 'partner_callback', ?, ?)`,
        ).run(
          newId('obx'),
          JSON.stringify({ partner_id: partner.id, body, signature: hmacSha256Hex(partner.callback_secret, body) }),
          isoNow(),
        );
      }
    }
    return { ok: true, orderStatus: 'awaiting_delivery' };
  },
};

/**
 * Kite-session route. Live paid execution is deliberately disabled:
 * no owner authority for a paid dispatch exists in this run, so every attempt
 * fails closed and is recorded (KITE-AND-PROVIDERS fail-closed requirement).
 */
const kiteSessionAdapter: Adapter = {
  rail: 'kite_session',
  dispatch(_db, _order, _partner) {
    return {
      ok: false,
      failureReason: 'provider_capability_blocked',
      detail: 'live kite_session dispatch has no owner authority in this run; order held blocked_external',
    };
  },
};

const ADAPTERS: Record<string, Adapter> = {
  local_demo: localDemoAdapter,
  kite_session: kiteSessionAdapter,
};

export function adapterFor(rail: string): Adapter | null {
  return ADAPTERS[rail] ?? null;
}
