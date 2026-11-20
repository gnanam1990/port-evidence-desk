import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { notFound } from '../domain/errors.ts';
import { runIdempotent, type Actor } from '../domain/audit.ts';
import { postCredit } from '../domain/credits.ts';
import { parseToMinor } from '../util/money.ts';

type Api = (method: string, path: string, fn: (ctx: import('../http/router.ts').RequestCtx, actor: Actor | null) => unknown, roles?: Actor['role'][]) => void;

export function registerCreditApi(api: Api, db: Db, _cfg: AppConfig): void {
  api('POST', '/cases/:id/credits', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; rawBody: string; headers: Record<string, string | string[] | undefined> };
    const body = JSON.parse(p.rawBody || '{}');
    const currency = String(body.currency ?? '');
    let amount: number;
    try {
      amount = parseToMinor(body.amount_minor ?? body.amount, currency);
    } catch (e) {
      throw notFound('bad_amount', (e as Error).message);
    }
    const { operation, result, deduplicated } = runIdempotent(
      db,
      {
        tenantId: actor!.tenantId, kind: 'cases.credit',
        idemKey: p.headers['idempotency-key'] as string | undefined,
        actor: actor!, payload: { case_id: p.params.id, ...body },
      },
      () =>
        postCredit(db, {
          actor: actor!, caseId: p.params.id,
          reference: String(body.reference ?? ''),
          amountMinor: amount, currency,
          effectiveOn: String(body.effective_on ?? ''),
          chargeLineId: body.charge_line_id ?? null,
        }),
    );
    return { ...result, operation_id: operation.id, replayed: deduplicated };
  }, ['accounts']);
}
