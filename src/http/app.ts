import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { Router, readBody, type RequestCtx } from './router.ts';
import { actorFromRequest, createSession, requireRole } from './auth.ts';
import { ApiError, notFound } from '../domain/errors.ts';
import { audit, runIdempotent, type Actor } from '../domain/audit.ts';
import { importInvoice, resolveInvoiceConflict } from '../domain/intake.ts';
import { all, one } from '../db.ts';
import { registerTariffApi } from '../api/tariffs.ts';
import { registerEventApi } from '../api/events.ts';
import { registerQuoteApi } from '../api/quotes.ts';
import { registerPartnerApi } from '../api/partners.ts';
import { registerFixtureApi } from '../api/fixtures.ts';
import { registerPackageApi } from '../api/packages.ts';
import { registerCreditApi } from '../api/credits.ts';
import { registerOpsApi } from '../api/ops.ts';
import { registerUi } from '../ui/routes.ts';

interface Ctx extends RequestCtx {
  db: Db;
  cfg: AppConfig;
  req: IncomingMessage;
}

type ApiHandler = (ctx: Ctx, actor: Actor | null) => unknown;

export function buildHandler(db: Db, cfg: AppConfig) {
  const router = new Router();
  const api = (method: string, path: string, fn: ApiHandler, roles?: Actor['role'][]) => {
    router.add(method, path, async (ctx) => {
      const actor = actorFromRequest(db, ctx.headers);
      if (roles) requireRole(actor, ...roles);
      return fn(ctx as Ctx, actor);
    });
  };

  // Unauthenticated utility routes
  router.add('GET', '/health', () => ({ ok: true, service: 'port-evidence-desk' }));
  router.add('POST', '/sessions', (ctx) => {
    const body = JSON.parse(ctx.rawBody || '{}');
    return createSession(db, String(body.name ?? ''), String(body.pin ?? ''));
  });

  // --- FR-01 intake ---
  api('POST', '/cases/import', async (ctx, actor) => {
    const body = JSON.parse(ctx.rawBody || '{}');
    if (typeof body.content !== 'string') {
      throw new ApiError(400, 'bad_body', 'expected {format, filename, content} JSON envelope');
    }
    const provenance = body.provenance === 'demo' ? 'demo' : 'customer';
    const { operation, result, deduplicated } = runIdempotent(
      db,
      {
        tenantId: actor!.tenantId,
        kind: 'cases.import',
        idemKey: ctx.headers['idempotency-key'] as string | undefined,
        actor: actor!,
        payload: { format: body.format, filename: body.filename, content: body.content },
      },
      () =>
        importInvoice(db, {
          actor: actor!,
          format: String(body.format ?? ''),
          filename: body.filename ?? null,
          raw: body.content,
          provenance,
          maxCsvRows: cfg.maxCsvRows,
        }),
    );
    if (!deduplicated && (result as { status?: string }).status === 'conflict') {
      const r = result as { case_id: string; revision: number; conflict_id?: string };
      throw new ApiError(409, 'invoice_revision_conflict',
        'changed document under an existing invoice key; held for review',
        { case_id: r.case_id, revision: r.revision, conflict_id: r.conflict_id });
    }
    return { ...result, operation_id: operation.id, replayed: deduplicated };
  }, ['analyst']);

  api('GET', '/cases', (_ctx, actor) => {
    return all(
      db,
      `SELECT id, invoice_ref, container_ref, voyage_ref, terminal_id, currency, state, source_class, created_at
       FROM cases WHERE tenant_id = ? ORDER BY created_at DESC`,
      actor!.tenantId,
    );
  });

  api('GET', '/cases/:id', (ctx, actor) => {
    return caseDetail(db, ctx.params.id, actor!);
  });

  api('POST', '/conflicts/:id/resolve-invoice', (ctx, actor) => {
    const body = JSON.parse(ctx.rawBody || '{}');
    return resolveInvoiceConflict(db, {
      actor: actor!,
      conflictId: ctx.params.id,
      winningRevision: Number(body.revision),
      reason: String(body.reason ?? ''),
    });
  }, ['analyst', 'manager']);

  registerTariffApi(api, db, cfg);
  registerEventApi(api, db, cfg);
  registerQuoteApi(api, db, cfg);
  registerPartnerApi(router, db, cfg);
  registerPackageApi(api, db, cfg);
  registerCreditApi(api, db, cfg);
  registerOpsApi(api, db, cfg);
  registerFixtureApi(api, db, cfg);
  registerUi(router, db, cfg);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const started = Date.now();
    try {
      const rawBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')
        ? await readBody(req, cfg.maxBodyBytes)
        : '';
      const match = router.match(req.method ?? 'GET', url.pathname);
      if (!match) {
        if (router.methodAllowed(url.pathname)) {
          throw new ApiError(405, 'method_not_allowed', 'method not allowed on this route');
        }
        throw notFound('no_route', 'route not found');
      }
      const ctx: Ctx = {
        params: match.params,
        query: url.searchParams,
        rawBody,
        headers: req.headers,
        db,
        cfg,
        req,
      };
      const out = await match.handler(ctx);
      const marker = out as Record<string, unknown> | null;
      if (marker && typeof marker === 'object' && '__redirect' in marker) {
        const headers: Record<string, string> = { location: String(marker.__redirect) };
        if (marker.__cookie) headers['set-cookie'] = String(marker.__cookie);
        res.writeHead(303, headers);
        res.end();
      } else if (marker && typeof marker === 'object' && '__html' in marker) {
        const headers: Record<string, string> = {
          'content-type': String(marker.__contentType ?? 'text/html; charset=utf-8'),
        };
        if (marker.__cookie) headers['set-cookie'] = String(marker.__cookie);
        res.writeHead(Number(marker.status ?? 200), headers);
        res.end(String(marker.__html));
      } else {
        sendJson(res, 200, out);
      }
    } catch (err) {
      handleError(res, err);
    } finally {
      void started;
    }
  };
}

export function caseDetail(db: Db, caseId: string, actor: Actor) {
  const c = one<Record<string, unknown>>(
    db,
    'SELECT * FROM cases WHERE id = ? AND tenant_id = ?',
    caseId,
    actor.tenantId,
  );
  if (!c) throw notFound('case_not_found', 'case not found');
  const chargeLines = all(db, 'SELECT * FROM charge_lines WHERE case_id = ?', caseId);
  const docs = all(
    db,
    'SELECT id, revision, source_digest, filename, format, received_by, received_at, status, provenance FROM invoice_documents WHERE case_id = ? ORDER BY revision',
    caseId,
  );
  const events = all(
    db,
    `SELECT id, type, local_date, local_time, utc_offset, utc_instant, supplier, record_id, revision, source_digest, provenance, status, created_at
     FROM events WHERE case_id = ? ORDER BY local_date, utc_instant`,
    caseId,
  );
  const gaps = all(db, 'SELECT * FROM gaps WHERE case_id = ?', caseId);
  const calculation = one(
    db,
    'SELECT * FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1',
    caseId,
  );
  const conflicts = all(db, "SELECT * FROM conflicts WHERE case_id = ? AND status = 'open'", caseId);
  const credits = all(db, 'SELECT * FROM credits WHERE case_id = ?', caseId);
  const orders = all(db, 'SELECT * FROM evidence_orders WHERE case_id = ?', caseId);
  const packages = all(db, 'SELECT * FROM packages WHERE case_id = ?', caseId);
  return {
    ...c,
    charge_lines: chargeLines,
    invoice_documents: docs,
    events,
    gaps,
    latest_calculation: calculation ?? null,
    open_conflicts: conflicts,
    credits,
    evidence_orders: orders,
    packages,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function handleError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof ApiError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, detail: err.detail } });
    return;
  }
  const code = (err as { code?: string })?.code;
  if (code === 'idempotency_conflict') {
    sendJson(res, 409, { error: { code, message: (err as Error).message } });
    return;
  }
  if (err instanceof SyntaxError) {
    sendJson(res, 400, { error: { code: 'json_parse', message: 'request body is not valid JSON' } });
    return;
  }
  sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
  console.error(err);
}
