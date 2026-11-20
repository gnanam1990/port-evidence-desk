import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.ts';
import { all, one, tx } from '../db.ts';
import { newId, sha256Hex } from '../util/crypto.ts';
import { canonicalJson } from '../util/canonical.ts';
import { isoNow } from '../util/dates.ts';
import { badRequest, conflict, notFound, unprocessable } from './errors.ts';
import { audit, type Actor } from './audit.ts';
import { inputsDigest } from './calc.ts';
import { refreshCaseState } from './state.ts';

interface CalcRow {
  id: string; revision: number; inputs_digest: string; tariff_id: string | null;
  tariff_version: string | null; currency: string | null; status: string;
  billed_minor: number; expected_minor: number | null;
  expected_min_minor: number | null; expected_max_minor: number | null;
  variance_min_minor: number | null; variance_max_minor: number | null;
  day_breakdown: string;
}

/** Which licence governs redistribution of a partner-supplied record in exports. */
function eventLicense(db: Db, caseId: string, supplier: string): string {
  const row = one<{ redistribution_rights: string }>(
    db,
    `SELECT q.redistribution_rights FROM quotes q
     JOIN evidence_orders o ON o.quote_id = q.id
     JOIN partners p ON p.id = q.partner_id
     WHERE o.case_id = ? AND p.id = ? ORDER BY o.authorized_at DESC LIMIT 1`,
    caseId, supplier,
  );
  return row?.redistribution_rights ?? 'internal_only';
}

export function createPackage(
  db: Db, args: { actor: Actor; caseId: string },
): { package_id: string } {
  const { actor, caseId } = args;
  return tx(db, () => {
    const c = one<{ tenant_id: string; state: string }>(
      db, 'SELECT tenant_id, state FROM cases WHERE id = ?', caseId,
    );
    if (!c || c.tenant_id !== actor.tenantId) throw notFound('case_not_found', 'case not found');
    const calc = one<CalcRow>(
      db, 'SELECT * FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1', caseId,
    );
    if (!calc) throw unprocessable('no_calculation', 'compute an estimate before packaging');
    if (calc.status !== 'priced') {
      throw unprocessable('calculation_not_priced', `calculation is ${calc.status}; a single priced outcome is required for a claim`);
    }
    const existing = one<{ id: string }>(
      db, "SELECT id FROM packages WHERE case_id = ? AND status IN ('draft','approved')", caseId,
    );
    if (existing) throw conflict('package_exists', 'an active package already exists', existing);
    const id = newId('pkg');
    db.prepare(
      `INSERT INTO packages (id, case_id, calculation_id, inputs_digest, status, created_by, created_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
    ).run(id, caseId, calc.id, calc.inputs_digest, actor.name, isoNow());
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'package_created', detail: { package_id: id, case_id: caseId, calc_rev: calc.revision },
    });
    refreshCaseState(db, caseId);
    return { package_id: id };
  });
}

export function approvePackage(
  db: Db, args: { actor: Actor; packageId: string },
): { package_id: string } {
  const { actor } = args;
  return tx(db, () => {
    const p = one<{ id: string; case_id: string; status: string; inputs_digest: string }>(
      db, 'SELECT * FROM packages WHERE id = ?', args.packageId,
    );
    if (!p) throw notFound('package_not_found', 'package not found');
    const cs = one<{ tenant_id: string }>(db, 'SELECT tenant_id FROM cases WHERE id = ?', p.case_id);
    if (!cs || cs.tenant_id !== actor.tenantId) throw notFound('package_not_found', 'package not found');
    if (p.status !== 'draft') throw conflict('package_not_draft', `package is ${p.status}`);
    // INV-06: approval pins to the inputs it reviewed; a changed digest refuses.
    const current = inputsDigest(db, p.case_id);
    if (current !== p.inputs_digest) {
      db.prepare("UPDATE packages SET status = 'stale' WHERE id = ?").run(p.id);
      throw conflict('stale_inputs', 'case inputs changed since the package was drafted; re-draft and re-approve');
    }
    db.prepare("UPDATE packages SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?")
      .run(actor.name, isoNow(), p.id);
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'package_approved', detail: { package_id: p.id, case_id: p.case_id },
    });
    refreshCaseState(db, p.case_id);
    return { package_id: p.id };
  });
}

function moneyFmt(minor: number, asset: string): string {
  return `${(minor / 100).toFixed(2)} ${asset}`;
}

export function exportPackage(
  db: Db,
  args: { actor: Actor; packageId: string; exportDir: string },
): { package_id: string; manifest_sha: string; dir: string } {
  const { actor } = args;
  const { dir, manifest, manifestSha, caseId } = tx(db, () => {
    const p = one<{ id: string; case_id: string; calculation_id: string; status: string; inputs_digest: string }>(
      db, 'SELECT * FROM packages WHERE id = ?', args.packageId,
    );
    if (!p) throw notFound('package_not_found', 'package not found');
    const cs = one<{ id: string; tenant_id: string; invoice_ref: string; container_ref: string; voyage_ref: string; terminal_id: string; currency: string; source_class: string }>(
      db, 'SELECT * FROM cases WHERE id = ?', p.case_id,
    );
    if (!cs || cs.tenant_id !== actor.tenantId) throw notFound('package_not_found', 'package not found');
    if (p.status === 'stale') {
      throw conflict('stale_inputs', 'case inputs changed since the package was drafted; re-draft and re-approve');
    }
    if (p.status !== 'approved') {
      throw conflict('package_not_approved', `package is ${p.status}; manager approval is required before export`);
    }
    const current = inputsDigest(db, p.case_id);
    if (current !== p.inputs_digest) {
      db.prepare("UPDATE packages SET status = 'stale' WHERE id = ?").run(p.id);
      audit(db, {
        tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
        code: 'export_blocked_stale', detail: { package_id: p.id },
      });
      throw conflict('stale_approval', 'inputs changed since approval; the approval no longer covers this revision');
    }
    const calc = one<CalcRow>(db, 'SELECT * FROM calculations WHERE id = ?', p.calculation_id)!;
    const tariff = calc.tariff_id
      ? one<Record<string, unknown>>(
          db,
          `SELECT id, terminal_id, version, currency, terminal_tz, clock_trigger, free_days,
                  include_trigger_day, include_end_day, exempt_weekends, exempt_closures,
                  rate_tiers, closure_dates, effective_from, effective_to
           FROM tariffs WHERE id = ?`, calc.tariff_id)
      : null;
    const docs = all<Record<string, unknown>>(
      db,
      `SELECT revision, source_digest, filename, format, received_by, received_at, status, provenance
       FROM invoice_documents WHERE case_id = ? ORDER BY revision`, p.case_id);
    const events = all<Record<string, unknown>>(
      db,
      `SELECT id, type, local_date, local_time, utc_offset, utc_instant, supplier, record_id, revision,
              source_digest, provenance, status FROM events WHERE case_id = ? ORDER BY local_date`, p.case_id);
    const manifestEvents = events.map((e) => {
      const license = String(e.provenance).startsWith('partner_')
        ? eventLicense(db, p.case_id, String(e.supplier))
        : 'internal';
      const usable = e.status === 'proven';
      const attachable = license === 'attach_to_dispute' && usable;
      return {
        event_id: e.id, type: e.type, local_date: e.local_date,
        utc_offset: e.utc_offset, utc_instant: e.utc_instant,
        supplier: e.supplier, record_id: e.record_id, revision: e.revision,
        source_digest: e.source_digest, provenance: e.provenance, status: e.status,
        license, included_in_export: attachable || license === 'internal',
      };
    });
    const breakdown = JSON.parse(calc.day_breakdown) as { scenarios: { gate_out_date: string; days: { date: string; kind: string; charge_minor: number; chargeable_day: number | null; note: string }[] }[] };
    const variance = (calc.variance_max_minor ?? 0);
    const manifest = {
      schema: 'ped/claim-manifest@1',
      generated_at: isoNow(),
      source_class: cs.source_class,
      case: {
        id: cs.id, tenant_id: cs.tenant_id, invoice_ref: cs.invoice_ref,
        container_ref: cs.container_ref, voyage_ref: cs.voyage_ref,
        terminal_id: cs.terminal_id, currency: cs.currency,
      },
      invoice_documents: docs,
      tariff,
      calculation: {
        id: calc.id, revision: calc.revision, inputs_digest: calc.inputs_digest,
        status: calc.status, billed_minor: calc.billed_minor,
        expected_minor: calc.expected_minor,
        variance_minor: variance,
        day_breakdown: breakdown,
      },
      events: manifestEvents,
      dispute: {
        variance_minor: variance,
        currency: calc.currency ?? cs.currency,
        basis: 'authorized terminal gate record vs carrier-billed days',
      },
      approval: { approved_by: actor.name, package_id: p.id },
      redaction_note:
        'commercial counterparty identifiers beyond the carrier-facing claim are excluded; licensed partner records appear as digests/references unless rights permit attachment',
    };
    const manifestSha = sha256Hex(canonicalJson(manifest));
    const dir = path.join(args.exportDir, cs.tenant_id, cs.id, p.id);
    db.prepare(
      "UPDATE packages SET status = 'exported', manifest_sha = ?, export_dir = ?, exported_at = ?, exported_by = ? WHERE id = ?",
    ).run(manifestSha, dir, isoNow(), actor.name, p.id);
    audit(db, {
      tenantId: actor.tenantId, actor: actor.name, actorRole: actor.role,
      code: 'package_exported', detail: { package_id: p.id, manifest_sha: manifestSha, case_id: p.case_id },
    });
    refreshCaseState(db, p.case_id);
    return { dir, manifest, manifestSha, caseId: p.case_id };
  });
  void caseId;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(dir, 'manifest.sha256'), `${manifestSha}  manifest.json\n`);
  const scenario = manifest.calculation.day_breakdown.scenarios[0];
  const csv = ['date,kind,chargeable_day,charge_minor,note']
    .concat(scenario.days.map((d) => `${d.date},${d.kind},${d.chargeable_day ?? ''},${d.charge_minor},"${d.note.replaceAll('"', "'")}"`))
    .join('\n');
  writeFileSync(path.join(dir, 'day-ledger.csv'), csv + '\n');
  const cur = manifest.dispute.currency;
  writeFileSync(
    path.join(dir, 'claim.md'),
    [
      `# Demurrage dispute claim — ${manifest.case.invoice_ref}`,
      '',
      `Container ${manifest.case.container_ref} / voyage ${manifest.case.voyage_ref} at terminal ${manifest.case.terminal_id}.`,
      `Carrier billed ${moneyFmt(manifest.calculation.billed_minor, cur)};`,
      `tariff ${String((manifest.tariff as { version?: string } | null)?.version ?? 'unknown')} supports ${moneyFmt(manifest.calculation.expected_minor ?? 0, cur)}.`,
      `Disputed amount: ${moneyFmt(manifest.dispute.variance_minor, cur)}.`,
      '',
      'Basis: authorized terminal gate record; see day-ledger.csv and manifest.json for the pinned input digest.',
    ].join('\n') + '\n',
  );
  return { package_id: args.packageId, manifest_sha: manifestSha, dir };
}
