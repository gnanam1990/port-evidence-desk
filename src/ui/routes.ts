import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import type { Router, RequestCtx } from '../http/router.ts';
import { all, one } from '../db.ts';
import { actorFromRequest, createSession, requireRole } from '../http/auth.ts';
import { ApiError } from '../domain/errors.ts';
import type { Actor } from '../domain/audit.ts';
import { importInvoice, resolveInvoiceConflict } from '../domain/intake.ts';
import { ingestEvent, resolveEventConflict } from '../domain/events.ts';
import { recomputeCase } from '../domain/calc.ts';
import { captureQuote, setCaseBudget, authorizeQuote, validateConversion } from '../domain/quotes.ts';
import { createPackage, approvePackage, exportPackage } from '../domain/packages.ts';
import { postCredit, portfolioReport } from '../domain/credits.ts';
import { isDateString } from '../util/dates.ts';
import { parseToMinor } from '../util/money.ts';
import { newId } from '../util/crypto.ts';
import { esc, layout, money, statusChip, table } from './html.ts';
import { CSS } from './style.css.ts';
import { tx } from '../db.ts';
import { isoNow } from '../util/dates.ts';
import { caseDetail } from '../http/app.ts';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PILOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'pilot');

interface HtmlOut { __html: string; status?: number }
interface Redirect { __redirect: string }
const html = (body: string, status = 200): HtmlOut => ({ __html: body, status });
const redirect = (to: string): Redirect => ({ __redirect: to });
const back = (caseId: string, kind: 'ok' | 'err', text: string): Redirect =>
  redirect(`/cases/${caseId}?${kind === 'ok' ? 'notice' : 'error'}=${encodeURIComponent(text)}`);

function actorOrLogin(db: Db, ctx: RequestCtx): Actor | null {
  try {
    return actorFromRequest(db, ctx.headers);
  } catch {
    return null;
  }
}

function formBody(ctx: RequestCtx): URLSearchParams {
  return new URLSearchParams(ctx.rawBody);
}

async function uiAction(
  db: Db, ctx: RequestCtx, roles: Actor['role'][],
  fn: (actor: Actor, f: URLSearchParams) => Redirect | Promise<Redirect>,
): Promise<Redirect | HtmlOut> {
  const actor = actorOrLogin(db, ctx);
  if (!actor) return redirect('/login');
  try {
    requireRole(actor, ...roles);
    return await fn(actor, formBody(ctx));
  } catch (e) {
    const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : `error: ${(e as Error).message}`;
    const ref = formBody(ctx).get('_back') ?? '/';
    return redirect(`${ref}${ref.includes('?') ? '&' : '?'}error=${encodeURIComponent(msg)}`);
  }
}

export function registerUi(router: Router, db: Db, cfg: AppConfig): void {
  router.add('GET', '/static/style.css', () => ({
    __html: CSS, status: 200, __contentType: 'text/css; charset=utf-8',
  }));

  router.add('GET', '/login', (ctx) => {
    const err = ctx.query.get('error');
    return html(layout(null, 'Sign in', `
      <section class="card"><h2>Sign in</h2>
      ${err ? `<p class="notice err">${esc(err)}</p>` : ''}
      <form method="post" action="/ui/login">
        <label for="name">User</label>
        <select id="name" name="name">
          <option value="aisha">aisha — invoice analyst</option>
          <option value="mohan">mohan — operations manager</option>
          <option value="priya">priya — accounting reviewer</option>
          <option value="ops">ops — operator (read-only)</option>
          <option value="ravi">ravi — analyst, second tenant</option>
        </select>
        <label for="pin">PIN</label>
        <input id="pin" name="pin" type="password" autocomplete="current-password" required>
        <p><button type="submit">Sign in</button></p>
        <p class="empty">Demo users are seeded locally; pins live in src/seed.ts.</p>
      </form></section>`));
  });

  router.add('POST', '/ui/login', (ctx) => {
    const f = formBody(ctx);
    try {
      const { token } = createSession(db, f.get('name') ?? '', f.get('pin') ?? '');
      return { __redirect: '/', __cookie: `ped_session=${token}; HttpOnly; Path=/; SameSite=Lax` };
    } catch {
      return redirect('/login?error=invalid%20credentials');
    }
  });

  router.add('POST', '/ui/logout', () => ({
    __redirect: '/login',
    __cookie: 'ped_session=; HttpOnly; Path=/; Max-Age=0',
  }));

  router.add('GET', '/', (ctx) => {
    const actor = actorOrLogin(db, ctx);
    if (!actor) return redirect('/login');
    const cases = all<Record<string, unknown>>(
      db,
      `SELECT c.id, c.invoice_ref, c.container_ref, c.voyage_ref, c.state, c.currency, c.source_class,
              (SELECT variance_max_minor FROM calculations k WHERE k.case_id = c.id ORDER BY revision DESC LIMIT 1) AS var_max,
              (SELECT SUM(amount_minor) FROM credits r WHERE r.case_id = c.id) AS credited
       FROM cases c WHERE c.tenant_id = ? ORDER BY c.created_at DESC`,
      actor.tenantId,
    );
    const importForm = actor.role === 'analyst' ? `
      <details><summary>Import invoice</summary>
      <form method="post" action="/ui/import">
        <label for="fmt">Format</label>
        <select id="fmt" name="format"><option value="json">Canonical JSON</option><option value="csv">Bounded CSV</option></select>
        <label for="content">Payload</label>
        <textarea id="content" name="content" rows="8" style="width:100%" required></textarea>
        <p><button type="submit">Import</button></p>
      </form>
      <form method="post" action="/ui/import-fixture">
        <label for="fx">Licensed pilot fixture</label>
        <select id="fx" name="filename">${pilotFixtures().map((f) => `<option>${esc(f)}</option>`).join('')}</select>
        <p><button type="submit" class="secondary">Import fixture</button></p>
      </form></details>` : '';
    return html(layout(actor, 'Case queue', `
      <h2>Case queue</h2>
      ${table('Active and settled cases', [
        { key: 'invoice_ref', label: 'Invoice', render: (r) => `<a href="/cases/${esc(r.id)}">${esc(r.invoice_ref)}</a>` },
        { key: 'container_ref', label: 'Container' },
        { key: 'voyage_ref', label: 'Voyage' },
        { key: 'state', label: 'State', render: (r) => statusChip(String(r.state)) },
        { key: 'var_max', label: 'Disputed', render: (r) => money(r.var_max as number | null, String(r.currency)) },
        { key: 'credited', label: 'Recovered', render: (r) => money(r.credited as number | null, String(r.currency)) },
        { key: 'source_class', label: 'Source' },
      ], cases)}
      ${importForm}`, notice(ctx)));
  });

  router.add('GET', '/cases/:id', (ctx) => {
    const actor = actorOrLogin(db, ctx);
    if (!actor) return redirect('/login');
    const id = ctx.params.id;
    const c = one<Record<string, unknown>>(db, 'SELECT * FROM cases WHERE id = ? AND tenant_id = ?', id, actor.tenantId);
    if (!c) return html(layout(actor, 'Not found', '<p>Case not found.</p>', notice(ctx)), 404);
    return html(layout(actor, `Case ${c.invoice_ref}`, casePage(db, cfg, actor, id), notice(ctx)));
  });

  router.add('GET', '/portfolio', (ctx) => {
    const actor = actorOrLogin(db, ctx);
    if (!actor) return redirect('/login');
    const rep = portfolioReport(db, actor.tenantId);
    return html(layout(actor, 'Portfolio', `
      <h2>Portfolio rollup</h2>
      ${table('Per-currency subtotals', [
        { key: 'currency', label: 'Currency' },
        { key: 'disputed_minor', label: 'Disputed (potential, active cases)', render: (r) => money(r.disputed_minor as number, String(r.currency)) },
        { key: 'submitted_minor', label: 'Submitted (exported claims)', render: (r) => money(r.submitted_minor as number, String(r.currency)) },
        { key: 'credited_minor', label: 'Credited (recovered cash)', render: (r) => money(r.credited_minor as number, String(r.currency)) },
        { key: 'case_count', label: 'Cases' },
      ], rep.totals as unknown as Record<string, unknown>[])}
      <p class="empty">Disputed, submitted and credited are separate provenance classes; an export never moves cash.</p>`,
      notice(ctx)));
  });

  router.add('GET', '/ops', (ctx) => {
    const actor = actorOrLogin(db, ctx);
    if (!actor) return redirect('/login');
    const t = actor.tenantId;
    const rows = (sql: string, ...p: (string | number)[]) =>
      all<Record<string, unknown>>(db, sql, ...p);
    return html(layout(actor, 'Operations', `
      <h2>Status ledger</h2>
      <section class="card"><h3>Pending / failed outbox</h3>
      ${table('Outbox rows needing attention', [
        { key: 'id', label: 'ID', render: (r) => `<span class="mono">${esc(r.id)}</span>` },
        { key: 'kind', label: 'Kind' }, { key: 'status', label: 'Status', render: (r) => statusChip(String(r.status)) },
        { key: 'attempts', label: 'Attempts' }, { key: 'last_error', label: 'Last error' },
      ], rows("SELECT id, kind, status, attempts, last_error FROM outbox WHERE status IN ('pending','processing','failed')"))}</section>
      <section class="card"><h3>Orders needing attention</h3>
      ${table('Orders', [
        { key: 'id', label: 'Order', render: (r) => `<a href="/cases/${esc(r.case_id)}"><span class="mono">${esc(String(r.id).slice(0, 18))}…</span></a>` },
        { key: 'rail', label: 'Rail' }, { key: 'status', label: 'Status', render: (r) => statusChip(String(r.status)) },
        { key: 'failure_reason', label: 'Reason' },
      ], rows("SELECT id, case_id, rail, status, failure_reason FROM evidence_orders WHERE tenant_id = ? AND status IN ('pending_reconciliation','blocked_external','awaiting_delivery')", t))}</section>
      <section class="card"><h3>Parked / rejected callbacks</h3>
      ${table('Callbacks', [
        { key: 'id', label: 'ID', render: (r) => `<span class="mono">${esc(r.id)}</span>` },
        { key: 'record_id', label: 'Record' }, { key: 'outcome', label: 'Outcome' },
        { key: 'order_ref', label: 'Order ref' },
        { key: 'retry', label: '', render: (r) => ['analyst', 'manager'].includes(actor.role) && ['parked_unknown_order', 'rejected'].includes(String(r.outcome))
          ? `<form method="post" action="/ui/callbacks/${esc(r.id)}/retry" class="inline"><button type="submit" class="secondary">Retry</button></form>` : '' },
      ], rows(`SELECT pc.id, pc.record_id, pc.outcome, pc.order_ref FROM partner_callbacks pc
               JOIN partners p ON p.id = pc.partner_id WHERE p.tenant_id = ? AND pc.outcome IN ('parked_unknown_order','rejected')`, t))}</section>
      <section class="card"><h3>Provider capability ledger</h3>
      ${table('Configured providers and their real capability', [
        { key: 'name', label: 'Partner' },
        { key: 'status', label: 'Status', render: (r) => statusChip(String(r.status)) },
        { key: 'capabilities', label: 'Capabilities' },
      ], rows('SELECT name, capabilities, status FROM partners WHERE tenant_id = ?', t).map((r) => ({ ...r, capabilities: JSON.stringify(JSON.parse(String(r.capabilities))) })))}
      <p class="empty">Rails: local_demo = team-controlled fake merchant (settlement scope: local demo only).
      kite_session = paid route; disabled without owner authority — orders fail closed to blocked_external.</p></section>`,
      notice(ctx)));
  });

  // --- UI actions (form posts; every one mirrors a JSON API path) ---

  router.add('POST', '/ui/import', (ctx) =>
    uiAction(db, ctx, ['analyst'], async (actor, f) => {
      const res = importInvoice(db, {
        actor, format: String(f.get('format') ?? ''), filename: 'console-paste',
        raw: String(f.get('content') ?? ''), provenance: 'demo', maxCsvRows: cfg.maxCsvRows,
      });
      return back(res.case_id, 'ok', `case ${res.status} (revision ${res.revision})`);
    }));

  router.add('POST', '/ui/import-fixture', (ctx) =>
    uiAction(db, ctx, ['analyst'], async (actor, f) => {
      const name = String(f.get('filename') ?? '');
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) throw new ApiError(400, 'bad_fixture', 'bad fixture name');
      const raw = readFileSync(path.join(PILOT_DIR, name), 'utf8');
      const res = importInvoice(db, {
        actor, format: 'json', filename: `pilot:${name}`, raw,
        provenance: 'pilot_fixture', maxCsvRows: cfg.maxCsvRows,
      });
      return back(res.case_id, 'ok', `fixture imported (revision ${res.revision})`);
    }));

  router.add('POST', '/ui/cases/:id/tariff', (ctx) =>
    uiAction(db, ctx, ['analyst'], async (actor, f) => {
      const caseId = ctx.params.id;
      const t = one<{ id: string; version: string; terminal_id: string; tenant_id: string }>(
        db, 'SELECT * FROM tariffs WHERE id = ?', f.get('tariff_id') ?? '');
      const c = one<{ terminal_id: string }>(db, 'SELECT terminal_id FROM cases WHERE id = ?', caseId);
      if (!t || !c || t.terminal_id !== c.terminal_id || t.tenant_id !== actor.tenantId) {
        throw new ApiError(400, 'tariff_mismatch', 'tariff does not govern this terminal');
      }
      tx(db, () => {
        db.prepare('UPDATE cases SET tariff_id = ?, tariff_version = ? WHERE id = ?').run(t.id, t.version, caseId);
        recomputeCase(db, caseId, actor.name);
      });
      return back(caseId, 'ok', `tariff ${t.version} pinned`);
    }));

  router.add('POST', '/ui/cases/:id/event', (ctx) =>
    uiAction(db, ctx, ['analyst'], async (actor, f) => {
      const res = ingestEvent(db, ctx.params.id, {
        type: String(f.get('type') ?? ''), local_date: String(f.get('local_date') ?? ''),
        utc_offset: String(f.get('utc_offset') ?? '+05:30'),
        supplier: 'analyst', record_id: `manual-${Date.now()}`, provenance: 'analyst_manual',
        created_by: actor.name, detail: { entered_via: 'casebook' },
      });
      return back(ctx.params.id, 'ok', `event ${res.outcome}`);
    }));

  router.add('POST', '/ui/cases/:id/gap', (ctx) =>
    uiAction(db, ctx, ['analyst'], async (actor, f) => {
      const caseId = ctx.params.id;
      const from = f.get('plausible_from') || null;
      const to = f.get('plausible_to') || null;
      if ((from && !isDateString(from)) || (to && !isDateString(to))) {
        throw new ApiError(400, 'bad_bound', 'bounds must be YYYY-MM-DD');
      }
      tx(db, () => {
        const g = one<{ id: string }>(db, "SELECT id FROM gaps WHERE case_id = ? AND required_event = 'gate_out'", caseId);
        if (g) {
          db.prepare("UPDATE gaps SET plausible_from = ?, plausible_to = ?, bound_reason = ?, status = 'open' WHERE id = ?")
            .run(from, to, f.get('bound_reason') ?? '', g.id);
        } else {
          db.prepare("INSERT INTO gaps (id, case_id, required_event, plausible_from, plausible_to, bound_reason, status, created_at) VALUES (?, ?, 'gate_out', ?, ?, ?, 'open', ?)")
            .run(newId('gap'), caseId, from, to, f.get('bound_reason') ?? '', isoNow());
        }
        recomputeCase(db, caseId, actor.name);
      });
      return back(caseId, 'ok', 'gap bounds saved');
    }));

  router.add('POST', '/ui/cases/:id/budget', (ctx) =>
    uiAction(db, ctx, ['manager'], async (actor, f) => {
      const asset = String(f.get('asset') ?? 'INR');
      setCaseBudget(db, {
        actor, caseId: ctx.params.id, asset,
        ceilingMinor: parseToMinor(String(f.get('ceiling') ?? ''), asset),
        policyRef: String(f.get('policy_ref') ?? ''),
      });
      return back(ctx.params.id, 'ok', 'evidence cap set');
    }));

  router.add('POST', '/ui/gaps/:id/quote', (ctx) =>
    uiAction(db, ctx, ['analyst'], async (actor, f) => {
      const gap = one<{ case_id: string }>(db, 'SELECT case_id FROM gaps WHERE id = ?', ctx.params.id)!;
      const asset = String(f.get('asset') ?? 'INR');
      const conv = f.get('conv_rate_num')
        ? {
            rate_num: Number(f.get('conv_rate_num')), rate_den: Number(f.get('conv_rate_den') ?? 1),
            to_asset: String(f.get('conv_to_asset') ?? ''), pinned_at: String(f.get('conv_pinned_at') ?? ''),
            valid_until: String(f.get('conv_valid_until') ?? ''), source: String(f.get('conv_source') ?? ''),
          }
        : null;
      const res = captureQuote(db, {
        actor, gapId: ctx.params.id, partnerId: String(f.get('partner_id') ?? ''),
        priceMinor: parseToMinor(String(f.get('price') ?? ''), asset), asset,
        expiresAt: String(f.get('expires_at') ?? '2999-01-01T00:00:00Z'),
        redistributionRights: String(f.get('rights') ?? 'reference_only'),
        conversion: validateConversion(conv),
      });
      return back(gap.case_id, 'ok', `quote ${res.quote_id.slice(0, 14)} captured`);
    }));

  router.add('POST', '/ui/quotes/:id/authorize', (ctx) =>
    uiAction(db, ctx, ['manager'], async (actor, f) => {
      const res = authorizeQuote(db, { actor, quoteId: ctx.params.id });
      void f;
      return back(String(one<{ case_id: string }>(
        db, 'SELECT case_id FROM evidence_orders WHERE id = ?', res.order_id)!.case_id),
        'ok', `order authorized on ${res.rail}`);
    }));

  router.add('POST', '/ui/cases/:id/package', (ctx) =>
    uiAction(db, ctx, ['analyst'], async (actor) => {
      const res = createPackage(db, { actor, caseId: ctx.params.id });
      return back(ctx.params.id, 'ok', `package drafted ${res.package_id.slice(0, 14)}`);
    }));

  router.add('POST', '/ui/packages/:id/approve', (ctx) =>
    uiAction(db, ctx, ['manager'], async (actor) => {
      const p = one<{ case_id: string }>(db, 'SELECT case_id FROM packages WHERE id = ?', ctx.params.id)!;
      approvePackage(db, { actor, packageId: ctx.params.id });
      return back(p.case_id, 'ok', 'package approved');
    }));

  router.add('POST', '/ui/packages/:id/export', (ctx) =>
    uiAction(db, ctx, ['analyst', 'manager'], async (actor) => {
      const p = one<{ case_id: string }>(db, 'SELECT case_id FROM packages WHERE id = ?', ctx.params.id)!;
      const res = exportPackage(db, { actor, packageId: ctx.params.id, exportDir: cfg.exportDir });
      return back(p.case_id, 'ok', `exported manifest ${res.manifest_sha.slice(0, 12)}…`);
    }));

  router.add('POST', '/ui/cases/:id/credit', (ctx) =>
    uiAction(db, ctx, ['accounts'], async (actor, f) => {
      const res = postCredit(db, {
        actor, caseId: ctx.params.id, reference: String(f.get('reference') ?? ''),
        amountMinor: parseToMinor(String(f.get('amount') ?? ''), String(f.get('currency') ?? '')),
        currency: String(f.get('currency') ?? ''), effectiveOn: String(f.get('effective_on') ?? ''),
      });
      return back(ctx.params.id, 'ok', res.deduplicated ? 'credit already recorded' : 'credit posted');
    }));

  router.add('POST', '/ui/conflicts/:id/resolve-event', (ctx) =>
    uiAction(db, ctx, ['analyst', 'manager'], async (actor, f) => {
      const res = resolveEventConflict(db, {
        actor, conflictId: ctx.params.id,
        winnerEventId: String(f.get('winner_event_id') ?? ''), reason: String(f.get('reason') ?? ''),
      });
      return back(res.case_id, 'ok', 'conflict resolved');
    }));

  router.add('POST', '/ui/conflicts/:id/resolve-invoice', (ctx) =>
    uiAction(db, ctx, ['analyst', 'manager'], async (actor, f) => {
      const res = resolveInvoiceConflict(db, {
        actor, conflictId: ctx.params.id,
        winningRevision: Number(f.get('revision')), reason: String(f.get('reason') ?? ''),
      });
      return back(res.case_id, 'ok', 'invoice conflict resolved');
    }));

  router.add('POST', '/ui/callbacks/:id/retry', (ctx) =>
    uiAction(db, ctx, ['analyst', 'manager'], async () => {
      const cb = one<{ id: string; partner_id: string; body: string }>(
        db, 'SELECT id, partner_id, body FROM partner_callbacks WHERE id = ?', ctx.params.id)!;
      const partner = one<{ id: string; callback_secret: string; tenant_id: string } & import('../adapters/provider.ts').PartnerRow>(
        db, 'SELECT * FROM partners WHERE id = ?', cb.partner_id)!;
      const { hmacSha256Hex } = await import('../util/crypto.ts');
      tx(db, () => db.prepare('DELETE FROM partner_callbacks WHERE id = ?').run(cb.id));
      const { processPartnerCallback } = await import('../domain/reconcile.ts');
      const res = processPartnerCallback(db, {
        partner, body: cb.body, signature: hmacSha256Hex(partner.callback_secret, cb.body),
      });
      return redirect(`/ops?notice=${encodeURIComponent(`retried → ${res.outcome}`)}`);
    }));
}

function pilotFixtures(): string[] {
  try {
    return readdirSync(PILOT_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function notice(ctx: RequestCtx): { kind: string; text: string } | undefined {
  const n = ctx.query.get('notice');
  const e = ctx.query.get('error');
  if (n) return { kind: 'ok', text: n };
  if (e) return { kind: 'err', text: e };
  return undefined;
}

function field(name: string, label: string, value = '', type = 'text'): string {
  return `<label for="${esc(name)}">${esc(label)}</label><input id="${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}">`;
}

function hiddenBack(ctxPath: string): string {
  return `<input type="hidden" name="_back" value="${esc(ctxPath)}">`;
}

function casePage(db: Db, _cfg: AppConfig, actor: Actor, caseId: string): string {
  const c = caseDetail(db, caseId, actor) as Record<string, unknown>;
  const backPath = `/cases/${caseId}`;
  const ccy = String(c.currency);
  const calc = c.latest_calculation as Record<string, unknown> | null;
  const tariffs = all<Record<string, unknown>>(
    db, 'SELECT id, version, effective_from FROM tariffs WHERE tenant_id = ? AND terminal_id = ? ORDER BY effective_from',
    actor.tenantId, String(c.terminal_id),
  );
  const partners = all<Record<string, unknown>>(
    db, 'SELECT id, name, capabilities, status FROM partners WHERE tenant_id = ?', actor.tenantId,
  );
  const quotes = all<Record<string, unknown>>(
    db, `SELECT q.*, g.case_id FROM quotes q JOIN gaps g ON g.id = q.gap_id WHERE g.case_id = ?`, caseId,
  );
  const breakdown = calc?.day_breakdown
    ? (JSON.parse(String(calc.day_breakdown)) as { scenarios?: { label: string; gate_out_date: string; expected_minor: number; days: Record<string, unknown>[] }[] })
    : null;

  const sections: string[] = [];
  sections.push(`
    <section class="card"><h2>Case ${esc(c.invoice_ref)}</h2>
    <div class="kv">
      <div><dt>State</dt><dd>${statusChip(String(c.state))}</dd></div>
      <div><dt>Container</dt><dd>${esc(c.container_ref)}</dd></div>
      <div><dt>Voyage</dt><dd>${esc(c.voyage_ref)}</dd></div>
      <div><dt>Terminal</dt><dd>${esc(c.terminal_id)}</dd></div>
      <div><dt>Tariff</dt><dd>${c.tariff_version ? esc(c.tariff_version) : 'not pinned'}</dd></div>
      <div><dt>Evidence cap</dt><dd>${c.ceiling_minor != null ? `${money(c.ceiling_minor as number, String(c.ceiling_asset))} · policy ${esc(c.ceiling_policy_ref)}` : 'unset'}</dd></div>
      <div><dt>Source class</dt><dd>${esc(c.source_class)}</dd></div>
    </div></section>`);

  // Invoice lines + provenance
  sections.push(`<section class="card"><h2>Invoice lines</h2>
    ${table('Charge lines from the accepted invoice revision', [
      { key: 'service', label: 'Service' },
      { key: 'billed_minor', label: 'Billed', render: (r) => money(r.billed_minor as number, ccy) },
      { key: 'period_start', label: 'Period start' },
      { key: 'period_end', label: 'Period end' },
    ], c.charge_lines as Record<string, unknown>[])}
    <h3>Import provenance</h3>
    ${table('Invoice document revisions', [
      { key: 'revision', label: 'Rev' }, { key: 'format', label: 'Format' },
      { key: 'source_digest', label: 'Digest', render: (r) => `<span class="mono">${esc(String(r.source_digest).slice(0, 16))}…</span>` },
      { key: 'status', label: 'Status', render: (r) => statusChip(String(r.status)) },
      { key: 'provenance', label: 'Provenance' }, { key: 'received_by', label: 'By' },
    ], c.invoice_documents as Record<string, unknown>[])}</section>`);

  // Tariff pin + day ledger + estimate
  const tariffForm = !c.tariff_id && actor.role === 'analyst' && tariffs.length
    ? `<form method="post" action="/ui/cases/${caseId}/tariff">${hiddenBack(backPath)}
        <label for="tariff_id">Governing tariff</label>
        <select id="tariff_id" name="tariff_id">${tariffs.map((t) => `<option value="${esc(t.id)}">${esc(t.version)} (from ${esc(t.effective_from)})</option>`).join('')}</select>
        <button type="submit">Pin tariff</button></form>` : '';
  const scenarios = breakdown?.scenarios ?? [];
  sections.push(`<section class="card"><h2>Day ledger</h2>${tariffForm}
    ${calc ? `<p>Calculation rev ${esc(calc.revision)} · ${statusChip(String(calc.status))} ·
      expected ${money(calc.expected_minor as number | null, String(calc.currency))}
      ${calc.expected_min_minor != null ? `(range ${money(calc.expected_min_minor as number, String(calc.currency))}–${money(calc.expected_max_minor as number, String(calc.currency))})` : ''}
      vs billed ${money(calc.billed_minor as number, String(calc.currency))}
      → potential dispute ${calc.variance_min_minor != null && calc.variance_min_minor !== calc.variance_max_minor
        ? `${money(calc.variance_min_minor as number, String(calc.currency))}–${money(calc.variance_max_minor as number, String(calc.currency))}`
        : money(calc.variance_max_minor as number, String(calc.currency))}</p>` : '<p class="empty">No calculation yet — pin the governing tariff.</p>'}
    ${scenarios.map((s, i) => `
      <h3>Scenario ${esc(s.label)} — expected ${money(s.expected_minor, String(calc!.currency))}</h3>
      ${table(`Day ledger ${i + 1}`, [
        { key: 'date', label: 'Date (terminal-local)' },
        { key: 'kind', label: 'Kind', render: (r) => statusChip(String(r.kind)) },
        { key: 'chargeable_day', label: 'Day #' },
        { key: 'charge_minor', label: 'Charge', render: (r) => money(r.charge_minor as number, String(calc!.currency)) },
        { key: 'note', label: 'Reason' },
      ], s.days)}`).join('')}
    </section>`);

  // Events + provenance
  sections.push(`<section class="card"><h2>Evidence events</h2>
    ${table('Records with provenance and original offsets', [
      { key: 'type', label: 'Type' }, { key: 'local_date', label: 'Local date' },
      { key: 'utc_offset', label: 'Offset' }, { key: 'supplier', label: 'Supplier' },
      { key: 'record_id', label: 'Record', render: (r) => `<span class="mono">${esc(String(r.record_id).slice(0, 22))}</span>` },
      { key: 'revision', label: 'Rev' },
      { key: 'provenance', label: 'Provenance' },
      { key: 'status', label: 'Status', render: (r) => statusChip(String(r.status)) },
      { key: 'source_digest', label: 'Digest', render: (r) => `<span class="mono">${esc(String(r.source_digest).slice(0, 12))}…</span>` },
    ], c.events as Record<string, unknown>[])}
    ${actor.role === 'analyst' ? `<details><summary>Post a manual event</summary>
      <form method="post" action="/ui/cases/${caseId}/event">${hiddenBack(backPath)}
      <label for="etype">Type</label>
      <select id="etype" name="type"><option value="discharge">discharge</option><option value="gate_out">gate_out</option><option value="gate_in">gate_in</option><option value="empty_return">empty_return</option></select>
      ${field('local_date', 'Local date (YYYY-MM-DD)')}${field('utc_offset', 'UTC offset', '+05:30')}
      <p><button type="submit">Record event</button></p></form></details>` : ''}</section>`);

  // Gaps, budget, quotes, orders
  const gaps = c.gaps as Record<string, unknown>[];
  const gapRows = gaps.map((g) => {
    const gq = quotes.filter((q) => q.gap_id === g.id);
    return {
      ...g,
      bounds: g.plausible_from ? `${g.plausible_from} → ${g.plausible_to}` : 'unbounded',
      quotes_html: gq.map((q) => quoteBlock(actor, q, backPath)).join('') || '<span class="empty">none</span>',
    };
  });
  const budgetForm = actor.role === 'manager' ? `
    <form method="post" action="/ui/cases/${caseId}/budget">${hiddenBack(backPath)}
    ${field('ceiling', 'Evidence cap (major units)')}${field('asset', 'Asset', ccy)}${field('policy_ref', 'Investigation policy ref')}
    <p><button type="submit">Set cap</button></p></form>` : '';
  sections.push(`<section class="card"><h2>Gaps, quotes and orders</h2>
    ${table('Open evidence gaps and partner quotes', [
      { key: 'required_event', label: 'Missing event' },
      { key: 'bounds', label: 'Plausible range' },
      { key: 'status', label: 'Gap', render: (r) => statusChip(String(r.status)) },
      { key: 'uncertainty_max_minor', label: 'At stake', render: (r) => money(r.uncertainty_max_minor as number | null, ccy) },
      { key: 'quotes_html', label: 'Quotes' },
    ], gapRows)}
    ${actor.role === 'analyst' && gaps.some((g) => ['open', 'unbounded'].includes(String(g.status))) ? `
    <details><summary>Set gap bounds / capture quote</summary>
      <form method="post" action="/ui/cases/${caseId}/gap">${hiddenBack(backPath)}
        ${field('plausible_from', 'Plausible from')}${field('plausible_to', 'Plausible to')}${field('bound_reason', 'Bound reason')}
        <p><button type="submit">Save bounds</button></p></form>
      ${gaps.filter((g) => ['open', 'unbounded'].includes(String(g.status))).map((g) => `
        <form method="post" action="/ui/gaps/${esc(g.id)}/quote">${hiddenBack(backPath)}
        <fieldset><legend>Quote for ${esc(g.required_event)}</legend>
        <label for="partner_id">Partner</label>
        <select id="partner_id" name="partner_id">${partners.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>
        ${field('price', 'Price (major units)')}${field('asset', 'Asset', ccy)}${field('expires_at', 'Expires (ISO)', '2999-01-01T00:00:00Z')}
        <label for="rights">Redistribution rights</label>
        <select id="rights" name="rights"><option value="attach_to_dispute">attach_to_dispute</option><option value="reference_only" selected>reference_only</option><option value="internal_only">internal_only</option></select>
        <details><summary>Cross-asset conversion (only if quote asset ≠ ${esc(ccy)})</summary>
          ${field('conv_rate_num', 'Rate numerator')}${field('conv_rate_den', 'Rate denominator', '1')}
          ${field('conv_to_asset', 'Convert to asset', ccy)}${field('conv_pinned_at', 'Pinned at (ISO)')}
          ${field('conv_valid_until', 'Valid until (ISO)')}${field('conv_source', 'Conversion source')}
        </details>
        <p><button type="submit">Capture quote</button></p></fieldset></form>`).join('')}
    </details>` : ''}
    ${budgetForm}
    ${table('Evidence orders', [
      { key: 'id', label: 'Order', render: (r) => `<span class="mono">${esc(String(r.id).slice(0, 16))}…</span>` },
      { key: 'rail', label: 'Rail' },
      { key: 'status', label: 'Status', render: (r) => statusChip(String(r.status)) },
      { key: 'amount_minor', label: 'Price', render: (r) => money(r.amount_minor as number, String(r.asset)) },
      { key: 'settlement_scope', label: 'Settlement' },
      { key: 'failure_reason', label: 'Reason' },
    ], c.evidence_orders as Record<string, unknown>[])}</section>`);

  // Conflicts
  const conflicts = c.open_conflicts as Record<string, unknown>[];
  sections.push(`<section class="card"><h2>Unresolved conflicts</h2>
    ${conflicts.length === 0 ? '<p class="empty">None.</p>' : conflicts.map((cf) => {
      const detail = JSON.parse(String(cf.detail)) as Record<string, unknown>;
      const inner = cf.kind === 'event_time'
        ? `<form method="post" action="/ui/conflicts/${esc(cf.id)}/resolve-event">${hiddenBack(backPath)}
           <label for="w_${esc(cf.id)}">Winning record</label>
           <select id="w_${esc(cf.id)}" name="winner_event_id">${(detail.candidates as string[]).map((eid) => `<option value="${esc(eid)}">${esc(eid.slice(0, 24))}</option>`).join('')}</select>
           ${field('reason', 'Resolution reason')}<p><button type="submit">Resolve</button></p></form>`
        : `<form method="post" action="/ui/conflicts/${esc(cf.id)}/resolve-invoice">${hiddenBack(backPath)}
           ${field('revision', 'Winning document revision', String(detail.revision ?? ''))}${field('reason', 'Resolution reason')}
           <p><button type="submit">Resolve</button></p></form>`;
      return `<div><p>${statusChip(String(cf.kind))} ${esc(String(detail.reason ?? ''))}</p>${inner}</div>`;
    }).join('')}</section>`);

  // Packages + credits + totals
  const packages = c.packages as Record<string, unknown>[];
  const credited = (c.credits as Record<string, unknown>[]).reduce((s, r) => s + Number(r.amount_minor), 0);
  sections.push(`<section class="card"><h2>Claim package and accounting</h2>
    <div class="totals">
      <div><b>Quoted dispute</b>${calc ? money(calc.variance_max_minor as number | null, ccy) : '—'}</div>
      <div><b>Approved package</b>${packages.some((p) => p.status === 'approved' || p.status === 'exported') ? money((calc?.variance_max_minor as number | null) ?? 0, ccy) : '—'}</div>
      <div><b>Confirmed credit</b>${money(credited, ccy)}</div>
    </div>
    ${table('Packages', [
      { key: 'id', label: 'Package', render: (r) => `<span class="mono">${esc(String(r.id).slice(0, 16))}…</span>` },
      { key: 'status', label: 'Status', render: (r) => statusChip(String(r.status)) },
      { key: 'manifest_sha', label: 'Manifest', render: (r) => r.manifest_sha ? `<span class="mono">${esc(String(r.manifest_sha).slice(0, 16))}…</span>` : '—' },
      { key: 'act', label: 'Actions', render: (r) => `
        ${actor.role === 'manager' && r.status === 'draft' ? `<form method="post" action="/ui/packages/${esc(r.id)}/approve" class="inline"><button type="submit">Approve</button></form>` : ''}
        ${['analyst', 'manager'].includes(actor.role) && r.status === 'approved' ? `<form method="post" action="/ui/packages/${esc(r.id)}/export" class="inline"><button type="submit">Export</button></form>` : ''}
        ${r.status === 'exported' ? `<a href="/packages/${esc(r.id)}/manifest">manifest (JSON)</a>` : ''}` },
    ], packages)}
    ${actor.role === 'analyst' && String(c.state) === 'analyst_review'
      ? `<form method="post" action="/ui/cases/${caseId}/package">${hiddenBack(backPath)}<button type="submit">Draft claim package</button></form>` : ''}
    <h3>Credits</h3>
    ${table('Carrier-issued credits', [
      { key: 'reference', label: 'Reference' },
      { key: 'amount_minor', label: 'Amount', render: (r) => money(r.amount_minor as number, String(r.currency)) },
      { key: 'effective_on', label: 'Effective' }, { key: 'source', label: 'Source' },
    ], c.credits as Record<string, unknown>[])}
    ${actor.role === 'accounts' ? `
    <form method="post" action="/ui/cases/${caseId}/credit">${hiddenBack(backPath)}
      ${field('reference', 'Carrier credit reference')}${field('amount', 'Amount (major units)')}${field('currency', 'Currency', ccy)}${field('effective_on', 'Effective date')}
      <p><button type="submit">Post credit</button></p></form>` : ''}
    </section>`);

  return sections.join('\n');
}

function quoteBlock(actor: Actor, q: Record<string, unknown>, backPath: string): string {
  const authorize = actor.role === 'manager' && q.status === 'open'
    ? `<form method="post" action="/ui/quotes/${esc(q.id)}/authorize" class="inline"><button type="submit">Authorize</button></form>` : '';
  return `<div>${money(q.price_minor as number, String(q.asset))} · ${statusChip(String(q.status))} ·
    rights ${esc(q.redistribution_rights)} · exp ${esc(String(q.expires_at).slice(0, 10))} ${authorize}</div>`;
}
