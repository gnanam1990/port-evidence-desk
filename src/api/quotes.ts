import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { all, one } from '../db.ts';
import { notFound } from '../domain/errors.ts';
import { runIdempotent, type Actor } from '../domain/audit.ts';
import { captureQuote, setCaseBudget, authorizeQuote, validateConversion } from '../domain/quotes.ts';
import { parseToMinor } from '../util/money.ts';

type Api = (method: string, path: string, fn: (ctx: import('../http/router.ts').RequestCtx, actor: Actor | null) => unknown, roles?: Actor['role'][]) => void;

export function registerQuoteApi(api: Api, db: Db, _cfg: AppConfig): void {
  api('POST', '/gaps/:id/quotes', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; rawBody: string };
    const body = JSON.parse(p.rawBody || '{}');
    const asset = String(body.asset ?? '');
    let priceMinor: number;
    try {
      priceMinor = parseToMinor(body.price_minor ?? body.price, asset);
    } catch (e) {
      throw notFound('bad_price', (e as Error).message);
    }
    return captureQuote(db, {
      actor: actor!,
      gapId: p.params.id,
      partnerId: String(body.partner_id ?? ''),
      priceMinor,
      asset,
      expiresAt: String(body.expires_at ?? ''),
      redistributionRights: String(body.redistribution_rights ?? 'reference_only'),
      conversion: validateConversion(body.conversion ?? null),
      serviceId: body.service_id ?? null,
      network: body.network ?? null,
      endpoint: body.endpoint ?? null,
      testEnvironment: body.test_environment ?? null,
      raw: p.rawBody,
    });
  }, ['analyst']);

  api('POST', '/cases/:id/budget', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; rawBody: string };
    const body = JSON.parse(p.rawBody || '{}');
    const asset = String(body.asset ?? body.currency ?? '');
    let ceiling: number;
    try {
      ceiling = parseToMinor(body.ceiling_minor ?? body.ceiling, asset);
    } catch (e) {
      throw notFound('bad_ceiling', (e as Error).message);
    }
    setCaseBudget(db, {
      actor: actor!,
      caseId: p.params.id,
      ceilingMinor: ceiling,
      asset,
      policyRef: String(body.policy_ref ?? ''),
    });
    return { ok: true, case_id: p.params.id, ceiling_minor: ceiling, asset };
  }, ['manager']);

  api('POST', '/quotes/:id/authorize', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; rawBody: string; headers: Record<string, string | string[] | undefined> };
    const { operation, result, deduplicated } = runIdempotent(
      db,
      {
        tenantId: actor!.tenantId,
        kind: 'quotes.authorize',
        idemKey: p.headers['idempotency-key'] as string | undefined,
        actor: actor!,
        payload: { quote_id: p.params.id },
      },
      () => authorizeQuote(db, { actor: actor!, quoteId: p.params.id }),
    );
    return { ...result, operation_id: operation.id, replayed: deduplicated };
  }, ['manager']);

  api('GET', '/cases/:id/quotes', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string> };
    const cs = one<{ tenant_id: string }>(db, 'SELECT tenant_id FROM cases WHERE id = ?', p.params.id);
    if (!cs || cs.tenant_id !== actor!.tenantId) throw notFound('case_not_found', 'case not found');
    return all(
      db,
      `SELECT q.* FROM quotes q JOIN gaps g ON g.id = q.gap_id WHERE g.case_id = ? ORDER BY q.captured_at`,
      p.params.id,
    );
  });
}
