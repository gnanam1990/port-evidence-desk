import type { Db } from '../db.ts';
import { all, one, tx } from '../db.ts';
import { newId, sha256Hex } from '../util/crypto.ts';
import { canonicalJson } from '../util/canonical.ts';
import { isDateString, isoNow } from '../util/dates.ts';
import { parseToMinor, MoneyError } from '../util/money.ts';
import { parseCsv } from './csv.ts';
import { badRequest, conflict } from './errors.ts';
import { audit, type Actor } from './audit.ts';

export interface ChargeLineInput {
  service: string;
  billed_minor: number;
  period_start: string | null;
  period_end: string | null;
}

export interface InvoiceInput {
  invoice_ref: string;
  container_ref: string;
  voyage_ref: string;
  terminal_id: string;
  currency: string;
  charge_lines: ChargeLineInput[];
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ASSET_RE = /^[A-Z][A-Z0-9]{1,9}$/;

function reqRef(name: string, v: unknown): string {
  if (typeof v !== 'string' || !REF_RE.test(v)) {
    throw badRequest('invalid_field', `${name} must be a reference token (1-128 chars, no spaces)`);
  }
  return v;
}

function optDate(name: string, v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (!isDateString(v)) throw badRequest('invalid_field', `${name} must be a YYYY-MM-DD date`);
  return v;
}

function normalizeLine(raw: Record<string, unknown>, currency: string, idx: number): ChargeLineInput {
  const service = typeof raw.service === 'string' && raw.service.trim() ? raw.service.trim() : null;
  if (!service) throw badRequest('invalid_field', `charge_lines[${idx}].service is required`);
  let billed: number;
  try {
    if (raw.billed_minor !== undefined && raw.billed_minor !== null && raw.billed_minor !== '') {
      // *_minor fields are already integer minor units.
      const v = raw.billed_minor;
      billed = typeof v === 'number' && Number.isInteger(v)
        ? v
        : typeof v === 'string' && /^-?\d+$/.test(v.trim())
          ? Number(v.trim())
          : (() => { throw new MoneyError('billed_minor must be an integer'); })();
    } else {
      billed = parseToMinor(raw.billed, currency);
    }
  } catch (e) {
    throw badRequest('invalid_field', `charge_lines[${idx}].billed: ${(e as MoneyError).message}`);
  }
  if (!Number.isSafeInteger(billed) || billed < 0) {
    throw badRequest('invalid_field', `charge_lines[${idx}].billed must be a non-negative minor-unit integer`);
  }
  const ps = optDate(`charge_lines[${idx}].period_start`, raw.period_start);
  const pe = optDate(`charge_lines[${idx}].period_end`, raw.period_end);
  if (ps && pe && pe < ps) {
    throw badRequest('invalid_field', `charge_lines[${idx}].period_end precedes period_start`);
  }
  return { service, billed_minor: billed, period_start: ps, period_end: pe };
}

const CSV_HEADER = [
  'invoice_ref',
  'container_ref',
  'voyage_ref',
  'terminal_id',
  'currency',
  'service',
  'billed_minor',
  'period_start',
  'period_end',
];

function parseInvoiceCsv(raw: string, maxCsvRows: number): InvoiceInput {
  const rows = parseCsv(raw, maxCsvRows + 1);
  if (rows.length < 2) throw badRequest('csv_empty', 'CSV needs a header row and at least one data row');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  for (const col of CSV_HEADER) {
    if (!header.includes(col)) throw badRequest('csv_header', `CSV is missing required column ${col}`);
  }
  const idx = (name: string) => header.indexOf(name);
  const dataRows = rows.slice(1);
  if (dataRows.length > maxCsvRows) {
    throw badRequest('csv_too_many_rows', `CSV exceeds ${maxCsvRows} data rows`);
  }
  let invoice: InvoiceInput | null = null;
  const lines: ChargeLineInput[] = [];
  dataRows.forEach((r, i) => {
    const get = (name: string) => (r[idx(name)] ?? '').trim();
    const cur = get('currency');
    const identity = {
      invoice_ref: reqRef('invoice_ref', get('invoice_ref')),
      container_ref: reqRef('container_ref', get('container_ref')),
      voyage_ref: reqRef('voyage_ref', get('voyage_ref')),
      terminal_id: reqRef('terminal_id', get('terminal_id')),
      currency: reqRef('currency', cur),
    };
    if (!ASSET_RE.test(identity.currency)) {
      throw badRequest('invalid_field', `row ${i + 1}: currency must be an uppercase asset code`);
    }
    if (invoice === null) {
      invoice = { ...identity, charge_lines: [] };
    } else {
      for (const k of ['invoice_ref', 'container_ref', 'voyage_ref', 'terminal_id', 'currency'] as const) {
        if (identity[k] !== invoice[k]) {
          throw badRequest('csv_mixed_identity', `row ${i + 1}: ${k} differs from earlier rows; one invoice per file`);
        }
      }
    }
    lines.push(
      normalizeLine(
        {
          service: get('service'),
          billed_minor: get('billed_minor'),
          period_start: get('period_start') || null,
          period_end: get('period_end') || null,
        },
        identity.currency,
        i,
      ),
    );
  });
  if (lines.length === 0 || invoice === null) {
    throw badRequest('csv_empty', 'CSV contains no charge lines');
  }
  return { ...(invoice as InvoiceInput), charge_lines: lines };
}

function parseInvoiceJson(raw: string): InvoiceInput {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw badRequest('json_parse', 'request body is not valid JSON');
  }
  const currency = reqRef('currency', doc.currency);
  if (!ASSET_RE.test(currency)) throw badRequest('invalid_field', 'currency must be an uppercase asset code');
  const linesRaw = doc.charge_lines;
  if (!Array.isArray(linesRaw) || linesRaw.length === 0) {
    throw badRequest('invalid_field', 'charge_lines must be a non-empty array');
  }
  if (linesRaw.length > 100) throw badRequest('invalid_field', 'charge_lines is limited to 100 entries');
  const charge_lines = linesRaw.map((l, i) =>
    normalizeLine((l ?? {}) as Record<string, unknown>, currency, i),
  );
  return {
    invoice_ref: reqRef('invoice_ref', doc.invoice_ref),
    container_ref: reqRef('container_ref', doc.container_ref),
    voyage_ref: reqRef('voyage_ref', doc.voyage_ref),
    terminal_id: reqRef('terminal_id', doc.terminal_id),
    currency,
    charge_lines,
  };
}

export function parseInvoiceDocument(format: string, raw: string, maxCsvRows: number): InvoiceInput {
  if (format === 'csv') return parseInvoiceCsv(raw, maxCsvRows);
  if (format === 'json') return parseInvoiceJson(raw);
  throw badRequest('bad_format', `unsupported invoice format ${JSON.stringify(format)}`);
}

interface CaseRow {
  id: string;
  tenant_id: string;
  state: string;
  invoice_ref: string;
}

interface DocRow {
  id: string;
  revision: number;
  source_digest: string;
  status: string;
}

/** Canonical comparison basis for "did the invoice change" (identity + normalized lines). */
function docCompareKey(inv: InvoiceInput): string {
  return canonicalJson(inv);
}

export interface ImportResult {
  case_id: string;
  invoice_ref: string;
  revision: number;
  deduplicated: boolean;
  status: 'created' | 'unchanged' | 'conflict';
  conflict_id?: string;
}

/**
 * FR-01 import: create or deduplicate a case by (tenant, invoice_ref).
 * INV-01: identical re-import is a no-op; a changed document under the same
 * invoice key opens a conflicting revision without touching charge lines.
 */
export function importInvoice(
  db: Db,
  args: {
    actor: Actor;
    format: string;
    filename: string | null;
    raw: string;
    provenance?: string;
    maxCsvRows: number;
  },
): ImportResult {
  const { actor } = args;
  const digest = sha256Hex(args.raw);
  const parsed = parseInvoiceDocument(args.format, args.raw, args.maxCsvRows);
  const provenance = args.provenance ?? 'customer';

  return tx(db, () => {
    const existing = one<CaseRow>(
      db,
      'SELECT id, tenant_id, state, invoice_ref FROM cases WHERE tenant_id = ? AND invoice_ref = ?',
      actor.tenantId,
      parsed.invoice_ref,
    );

    if (existing) {
      const sameDigest = one<DocRow>(
        db,
        'SELECT * FROM invoice_documents WHERE case_id = ? AND source_digest = ?',
        existing.id,
        digest,
      );
      if (sameDigest) {
        audit(db, {
          tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
          code: 'import_deduplicated', detail: { case_id: existing.id, digest },
        });
        return {
          case_id: existing.id, invoice_ref: parsed.invoice_ref,
          revision: sameDigest.revision, deduplicated: true, status: 'unchanged',
        };
      }

      const revRows = all<DocRow>(
        db,
        'SELECT id, revision, source_digest, status FROM invoice_documents WHERE case_id = ? ORDER BY revision',
        existing.id,
      );
      const nextRev = (revRows.at(-1)?.revision ?? 0) + 1;
      const activeDoc = revRows.find((r) => r.status === 'accepted');
      const activeParsed = activeDoc
        ? (JSON.parse(
            (one<{ parsed_json: string }>(
              db, 'SELECT parsed_json FROM invoice_documents WHERE id = ?', activeDoc.id,
            )!).parsed_json,
          ) as InvoiceInput)
        : null;

      if (activeParsed && docCompareKey(activeParsed) === docCompareKey(parsed)) {
        db.prepare(
          `INSERT INTO invoice_documents (id, case_id, revision, source_digest, filename, format, received_by, received_at, status, provenance, parsed_json, raw)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
        ).run(
          newId('doc'), existing.id, nextRev, digest, args.filename, args.format,
          actor.name, isoNow(), provenance, JSON.stringify(parsed), args.raw,
        );
        audit(db, {
          tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
          code: 'import_identical_content_new_digest', detail: { case_id: existing.id, revision: nextRev },
        });
        return {
          case_id: existing.id, invoice_ref: parsed.invoice_ref,
          revision: nextRev, deduplicated: true, status: 'unchanged',
        };
      }

      db.prepare(
        `INSERT INTO invoice_documents (id, case_id, revision, source_digest, filename, format, received_by, received_at, status, provenance, parsed_json, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'conflict', ?, ?, ?)`,
      ).run(
        newId('doc'), existing.id, nextRev, digest, args.filename, args.format,
        actor.name, isoNow(), provenance, JSON.stringify(parsed), args.raw,
      );
      const conflictId = newId('cfl');
      db.prepare(
        `INSERT INTO conflicts (id, case_id, kind, status, detail, created_at)
         VALUES (?, ?, 'invoice_revision', 'open', ?, ?)`,
      ).run(
        conflictId, existing.id,
        JSON.stringify({
          revision: nextRev,
          prior_revision: activeDoc?.revision ?? null,
          prior_digest: activeDoc?.source_digest ?? null,
          new_digest: digest,
        }),
        isoNow(),
      );
      db.prepare("UPDATE cases SET state = 'conflict_review', row_version = row_version + 1 WHERE id = ?").run(existing.id);
      audit(db, {
        tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
        code: 'import_conflict_revision', detail: { case_id: existing.id, revision: nextRev, conflict_id: conflictId },
      });
      return {
        case_id: existing.id, invoice_ref: parsed.invoice_ref,
        revision: nextRev, deduplicated: false, status: 'conflict', conflict_id: conflictId,
      };
    }

    const caseId = newId('case');
    db.prepare(
      `INSERT INTO cases (id, tenant_id, container_ref, voyage_ref, invoice_ref, terminal_id, currency, state, source_class, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    ).run(
      caseId, actor.tenantId, parsed.container_ref, parsed.voyage_ref,
      parsed.invoice_ref, parsed.terminal_id, parsed.currency,
      provenance, actor.name, isoNow(),
    );
    db.prepare(
      `INSERT INTO invoice_documents (id, case_id, revision, source_digest, filename, format, received_by, received_at, status, provenance, parsed_json, raw)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`,
    ).run(
      newId('doc'), caseId, digest, args.filename, args.format,
      actor.name, isoNow(), provenance, JSON.stringify(parsed), args.raw,
    );
    for (const line of parsed.charge_lines) {
      db.prepare(
        `INSERT INTO charge_lines (id, case_id, service, billed_minor, period_start, period_end, source)
         VALUES (?, ?, ?, ?, ?, ?, 'invoice')`,
      ).run(newId('cl'), caseId, line.service, line.billed_minor, line.period_start, line.period_end);
    }
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'case_created', detail: { case_id: caseId, invoice_ref: parsed.invoice_ref, digest },
    });
    return {
      case_id: caseId, invoice_ref: parsed.invoice_ref,
      revision: 1, deduplicated: false, status: 'created',
    };
  });
}

/** Resolve an invoice-revision conflict by choosing the revision that governs charge lines. */
export function resolveInvoiceConflict(
  db: Db,
  args: { actor: Actor; conflictId: string; winningRevision: number; reason: string },
): { case_id: string } {
  const { actor } = args;
  return tx(db, () => {
    const c = one<{ id: string; case_id: string; status: string; detail: string }>(
      db,
      `SELECT c.id, c.case_id, c.status, c.detail FROM conflicts c
       JOIN cases cs ON cs.id = c.case_id
       WHERE c.id = ? AND cs.tenant_id = ? AND c.kind = 'invoice_revision'`,
      args.conflictId,
      actor.tenantId,
    );
    if (!c) throw badRequest('conflict_not_found', 'no such invoice conflict for this tenant');
    if (c.status !== 'open') throw conflict('conflict_closed', 'conflict already resolved');
    const doc = one<DocRow & { parsed_json: string }>(
      db,
      'SELECT id, revision, source_digest, status, parsed_json FROM invoice_documents WHERE case_id = ? AND revision = ?',
      c.case_id,
      args.winningRevision,
    );
    if (!doc) throw badRequest('revision_not_found', 'no such document revision');
    const parsed = JSON.parse(doc.parsed_json) as InvoiceInput;
    db.prepare("UPDATE invoice_documents SET status = 'superseded' WHERE case_id = ? AND status = 'accepted' AND revision != ?")
      .run(c.case_id, doc.revision);
    db.prepare("UPDATE invoice_documents SET status = 'accepted' WHERE id = ?").run(doc.id);
    db.prepare('DELETE FROM charge_lines WHERE case_id = ?').run(c.case_id);
    for (const line of parsed.charge_lines) {
      db.prepare(
        `INSERT INTO charge_lines (id, case_id, service, billed_minor, period_start, period_end, source)
         VALUES (?, ?, ?, ?, ?, ?, 'invoice')`,
      ).run(newId('cl'), c.case_id, line.service, line.billed_minor, line.period_start, line.period_end);
    }
    db.prepare(
      `UPDATE conflicts SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution_reason = ? WHERE id = ?`,
    ).run(actor.name, isoNow(), args.reason, c.id);
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'invoice_conflict_resolved',
      detail: { case_id: c.case_id, winning_revision: doc.revision, reason: args.reason },
    });
    return { case_id: c.case_id };
  });
}
