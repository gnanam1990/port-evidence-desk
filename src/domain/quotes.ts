import type { Db } from '../db.ts';
import { one, tx } from '../db.ts';
import { newId } from '../util/crypto.ts';
import { isoNow } from '../util/dates.ts';
import { convertMinor } from '../util/money.ts';
import { badRequest, conflict, unprocessable, notFound } from './errors.ts';
import { audit, type Actor } from './audit.ts';
import { refreshCaseState } from './state.ts';

export interface Conversion {
  rate_num: number;
  rate_den: number;
  to_asset: string;
  pinned_at: string;
  valid_until: string;
  source: string;
}

export function validateConversion(v: unknown): Conversion | null {
  if (v === null || v === undefined) return null;
  const c = v as Record<string, unknown>;
  if (
    !Number.isInteger(c.rate_num) || !Number.isInteger(c.rate_den) ||
    typeof c.to_asset !== 'string' || typeof c.pinned_at !== 'string' ||
    typeof c.valid_until !== 'string' || typeof c.source !== 'string'
  ) {
    throw badRequest('bad_conversion', 'conversion needs rate_num, rate_den, to_asset, pinned_at, valid_until, source');
  }
  return c as unknown as Conversion;
}

interface GapRow {
  id: string; case_id: string; required_event: string; status: string;
  uncertainty_min_minor: number | null; uncertainty_max_minor: number | null;
}

interface QuoteRow {
  id: string; gap_id: string; partner_id: string; price_minor: number; asset: string;
  conversion_json: string | null; expires_at: string; redistribution_rights: string; status: string;
}

/** Convert `amount` from `asset` into the case currency via the quote's pinned conversion. */
function toCaseCurrency(
  amount: number, asset: string, caseCurrency: string, conv: Conversion | null,
): { amount: number; used: Conversion | null } | { error: string } {
  if (asset === caseCurrency) return { amount, used: null };
  if (!conv) return { error: 'conversion_required' };
  const now = isoNow();
  if (conv.to_asset !== caseCurrency) return { error: 'conversion_wrong_asset' };
  if (conv.valid_until < now) return { error: 'conversion_expired' };
  if (conv.pinned_at > now) return { error: 'conversion_not_yet_valid' };
  return { amount: convertMinor(amount, conv.rate_num, conv.rate_den), used: conv };
}

export interface AuthorizeResult {
  order_id: string;
  status: 'authorized';
  rail: string;
  settlement_scope: string;
}

/**
 * Quote authorization decision (FR-04 / INV-04).
 * Eligible only when: quote fresh, seller permitted, rights allow dispute use,
 * a case budget exists, price <= ceiling and price < recoverable bound — all
 * compared in the case currency with any required conversion pinned and valid.
 * Denials are audited with explicit reason codes; no order is created.
 */
export function authorizeQuote(
  db: Db,
  args: { actor: Actor; quoteId: string },
): AuthorizeResult {
  const { actor } = args;
  return tx(db, () => {
    const q = one<QuoteRow>(db, 'SELECT * FROM quotes WHERE id = ?', args.quoteId);
    if (!q) throw notFound('quote_not_found', 'quote not found');
    const gap = one<GapRow>(db, 'SELECT * FROM gaps WHERE id = ?', q.gap_id);
    const cs = one<{ id: string; tenant_id: string; currency: string; ceiling_minor: number | null; ceiling_asset: string | null }>(
      db, 'SELECT id, tenant_id, currency, ceiling_minor, ceiling_asset FROM cases WHERE id = ?', gap!.case_id,
    );
    if (!cs || cs.tenant_id !== actor.tenantId) throw notFound('quote_not_found', 'quote not found');
    const partner = one<{ id: string; status: string; capabilities: string }>(
      db, 'SELECT id, status, capabilities FROM partners WHERE id = ?', q.partner_id,
    );
    const caps = partner ? (JSON.parse(partner.capabilities) as Record<string, unknown>) : {};

    const deny = (reasons: string[]): never => {
      audit(db, {
        tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
        code: 'order_authorization_denied',
        detail: { quote_id: q.id, case_id: cs.id, reasons },
      });
      throw unprocessable('order_denied', `quote cannot be authorized: ${reasons.join(', ')}`, { reasons });
    };

    const reasons: string[] = [];
    if (q.status !== 'open') reasons.push(`quote_${q.status}`);
    const now = isoNow();
    if (q.expires_at <= now) {
      db.prepare("UPDATE quotes SET status = 'expired' WHERE id = ? AND status = 'open'").run(q.id);
      reasons.push('quote_expired');
    }
    if (!partner || partner.status !== 'configured') reasons.push('seller_not_permitted');
    if (caps.quote !== true) reasons.push('seller_no_quote_capability');
    if (q.redistribution_rights === 'internal_only') reasons.push('rights_do_not_permit_dispute_use');
    if (gap!.status !== 'open' && gap!.status !== 'unbounded') reasons.push(`gap_${gap!.status}`);
    if (cs.ceiling_minor === null || !cs.ceiling_asset) reasons.push('no_case_budget');

    const conv = q.conversion_json ? (JSON.parse(q.conversion_json) as Conversion) : null;
    let priceInCase: number | null = null;
    if (reasons.length === 0) {
      const convRes = toCaseCurrency(q.price_minor, q.asset, cs.currency, conv);
      if ('error' in convRes) {
        reasons.push(convRes.error);
      } else {
        priceInCase = convRes.amount;
        if (cs.ceiling_asset !== cs.currency) {
          reasons.push('ceiling_asset_not_case_currency');
        } else {
          if (priceInCase > cs.ceiling_minor!) reasons.push('over_ceiling');
          const bound = gap!.uncertainty_max_minor;
          if (bound === null || bound === undefined) reasons.push('no_recoverable_bound');
          else if (priceInCase >= bound) reasons.push('over_recoverable_bound');
        }
      }
    }
    if (reasons.length) deny(reasons);

    const live = one<{ id: string }>(
      db,
      `SELECT id FROM evidence_orders WHERE gap_id = ?
       AND status NOT IN ('cancelled','blocked_external','failed')`,
      gap!.id,
    );
    if (live) throw conflict('order_exists', 'this gap already has a live order', { order_id: live.id });

    const orderId = newId('ord');
    const rail = caps.execute === 'kite_session' ? 'kite_session' : 'local_demo';
    const settlementScope = rail === 'local_demo' ? 'local_demo' : 'external';
    db.prepare(
      `INSERT INTO evidence_orders
       (id, tenant_id, case_id, gap_id, quote_id, amount_minor, asset, ceiling_minor, ceiling_asset,
        converted_ceiling_minor, conversion_ref, rail, vendor_ref, status, settlement_scope, paid,
        authorized_by, authorized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, 0, ?, ?)`,
    ).run(
      orderId, cs.tenant_id, cs.id, gap!.id, q.id, q.price_minor, q.asset,
      cs.ceiling_minor, cs.ceiling_asset,
      q.asset === cs.currency ? null : priceInCase,
      conv ? `${conv.source}@${conv.pinned_at}` : null,
      rail, orderId, settlementScope, actor.name, isoNow(),
    );
    db.prepare("UPDATE quotes SET status = 'consumed' WHERE id = ?").run(q.id);
    db.prepare("UPDATE gaps SET status = 'ordered' WHERE id = ?").run(gap!.id);
    db.prepare(
      `INSERT INTO outbox (id, kind, payload, created_at) VALUES (?, 'dispatch_order', ?, ?)`,
    ).run(newId('obx'), JSON.stringify({ order_id: orderId }), isoNow());
    refreshCaseState(db, cs.id);
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'order_authorized',
      detail: {
        order_id: orderId, quote_id: q.id, case_id: cs.id,
        price_minor: q.price_minor, asset: q.asset, price_in_case_ccy: priceInCase,
        rail, settlement_scope: settlementScope,
      },
      externalRef: orderId,
    });
    return { order_id: orderId, status: 'authorized' as const, rail, settlement_scope: settlementScope };
  });
}

export function setCaseBudget(
  db: Db,
  args: { actor: Actor; caseId: string; ceilingMinor: number; asset: string; policyRef: string },
): void {
  const { actor } = args;
  const c = one<{ tenant_id: string; currency: string }>(
    db, 'SELECT tenant_id, currency FROM cases WHERE id = ?', args.caseId,
  );
  if (!c || c.tenant_id !== actor.tenantId) throw notFound('case_not_found', 'case not found');
  if (!Number.isSafeInteger(args.ceilingMinor) || args.ceilingMinor <= 0) {
    throw badRequest('bad_ceiling', 'ceiling must be a positive minor-unit integer');
  }
  if (!args.policyRef.trim()) {
    throw badRequest('policy_required', 'an explicit investigation policy reference is required');
  }
  tx(db, () => {
    db.prepare(
      'UPDATE cases SET ceiling_minor = ?, ceiling_asset = ?, ceiling_policy_ref = ?, ceiling_set_by = ?, row_version = row_version + 1 WHERE id = ?',
    ).run(args.ceilingMinor, args.asset, args.policyRef, actor.name, args.caseId);
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'budget_set',
      detail: { case_id: args.caseId, ceiling_minor: args.ceilingMinor, asset: args.asset, policy: args.policyRef },
    });
    refreshCaseState(db, args.caseId);
  });
}

export function captureQuote(
  db: Db,
  args: {
    actor: Actor; gapId: string; partnerId: string; priceMinor: number; asset: string;
    expiresAt: string; redistributionRights: string; conversion: Conversion | null;
    serviceId?: string | null; network?: string | null; endpoint?: string | null;
    testEnvironment?: string | null; raw?: string | null;
  },
): { quote_id: string } {
  const { actor } = args;
  const gap = one<GapRow>(db, 'SELECT * FROM gaps WHERE id = ?', args.gapId);
  if (!gap) throw notFound('gap_not_found', 'gap not found');
  const cs = one<{ tenant_id: string }>(db, 'SELECT tenant_id FROM cases WHERE id = ?', gap.case_id);
  if (!cs || cs.tenant_id !== actor.tenantId) throw notFound('gap_not_found', 'gap not found');
  const partner = one<{ id: string }>(db, 'SELECT id FROM partners WHERE id = ? AND tenant_id = ?',
    args.partnerId, actor.tenantId);
  if (!partner) throw notFound('partner_not_found', 'partner not found for this tenant');
  if (!Number.isSafeInteger(args.priceMinor) || args.priceMinor <= 0) {
    throw badRequest('bad_price', 'price must be a positive minor-unit integer');
  }
  if (!['attach_to_dispute', 'reference_only', 'internal_only'].includes(args.redistributionRights)) {
    throw badRequest('bad_rights', 'redistribution_rights must be attach_to_dispute, reference_only or internal_only');
  }
  if (typeof args.expiresAt !== 'string' || args.expiresAt.length < 10) {
    throw badRequest('bad_expiry', 'expires_at must be an ISO timestamp');
  }
  const id = newId('qot');
  tx(db, () => {
    db.prepare(
      `INSERT INTO quotes
       (id, gap_id, partner_id, service_id, endpoint, network, test_environment,
        price_minor, asset, conversion_json, expires_at, redistribution_rights, status,
        captured_by, captured_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(
      id, args.gapId, args.partnerId, args.serviceId ?? null, args.endpoint ?? null,
      args.network ?? null, args.testEnvironment ?? null,
      args.priceMinor, args.asset,
      args.conversion ? JSON.stringify(args.conversion) : null,
      args.expiresAt, args.redistributionRights,
      actor.name, isoNow(), args.raw ?? null,
    );
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'quote_captured',
      detail: { quote_id: id, gap_id: args.gapId, partner: args.partnerId, price_minor: args.priceMinor, asset: args.asset },
    });
  });
  return { quote_id: id };
}
