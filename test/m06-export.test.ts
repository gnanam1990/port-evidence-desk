import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { makeApp, importScene, pinDemoTariff, postEvent } from './helpers.ts';
import { DEMO } from '../src/seed.ts';
import { one } from '../src/db.ts';
import { drainOutbox } from '../src/worker.ts';
import { sha256Hex } from '../src/util/crypto.ts';
import { canonicalJson } from '../src/util/canonical.ts';

/** Deliver a May-4 gate-out via the full quote→order→callback pipeline. */
async function deliveredCase(app: Awaited<ReturnType<typeof makeApp>>) {
  const analyst = await app.login('analyst');
  const manager = await app.login('manager');
  const caseId = await importScene(app, analyst);
  await pinDemoTariff(app, analyst, caseId);
  await postEvent(app, analyst, caseId, { type: 'discharge', local_date: '2026-05-01' });
  await app.request('POST', `/cases/${caseId}/gaps`, {
    token: analyst,
    body: { required_event: 'gate_out', plausible_from: '2026-05-04', plausible_to: '2026-05-05', bound_reason: 'availability' },
  });
  await app.request('POST', `/cases/${caseId}/budget`, {
    token: manager, body: { ceiling_minor: 20000, asset: 'INR', policy_ref: 'POL-EV-01' },
  });
  const gapId = one<{ id: string }>(app.db, 'SELECT id FROM gaps WHERE case_id = ?', caseId)!.id;
  await app.request('POST', `/gaps/${gapId}/quotes`, {
    token: analyst,
    body: { partner_id: DEMO.partners.localDemo, price_minor: 15000, asset: 'INR', expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute' },
  });
  const quoteId = one<{ id: string }>(app.db, 'SELECT id FROM quotes WHERE gap_id = ?', gapId)!.id;
  await app.request('POST', `/quotes/${quoteId}/authorize`, { token: manager });
  drainOutbox(app.db, app.cfg);
  drainOutbox(app.db, app.cfg);
  return { caseId, analyst, manager };
}

test('T-011: the exported manifest pins inputs and reproduces the INR 1,000 variance', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const { caseId, analyst, manager } = await deliveredCase(app);
    const drafted = await app.request('POST', `/cases/${caseId}/packages`, { token: analyst });
    assert.equal(drafted.status, 200);
    const pkgId = (drafted.json as { package_id: string }).package_id;

    // Draft cannot be exported before approval.
    const early = await app.request('POST', `/packages/${pkgId}/export`, { token: analyst });
    assert.equal(early.status, 409);

    const appr = await app.request('POST', `/packages/${pkgId}/approve`, { token: manager });
    assert.equal(appr.status, 200);
    const exp = await app.request('POST', `/packages/${pkgId}/export`, {
      token: analyst, headers: { 'idempotency-key': 'exp-1' },
    });
    assert.equal(exp.status, 200);
    const body = exp.json as { manifest_sha: string; dir: string };
    assert.ok(existsSync(path.join(body.dir, 'manifest.json')));
    assert.ok(existsSync(path.join(body.dir, 'day-ledger.csv')));
    assert.ok(existsSync(path.join(body.dir, 'claim.md')));

    const manifest = JSON.parse(readFileSync(path.join(body.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'ped/claim-manifest@1');
    assert.equal(manifest.calculation.expected_minor, 200000); // INR 2,000
    assert.equal(manifest.dispute.variance_minor, 100000); // INR 1,000
    assert.equal(manifest.dispute.currency, 'INR');
    // Manifest sha recorded matches a canonical re-hash of the file's content.
    assert.equal(body.manifest_sha, sha256Hex(canonicalJson(manifest)));

    // Repeat export with the same key replays rather than overwriting.
    const exp2 = await app.request('POST', `/packages/${pkgId}/export`, {
      token: analyst, headers: { 'idempotency-key': 'exp-1' },
    });
    assert.equal((exp2.json as { replayed: boolean }).replayed, true);
  } finally {
    app.close();
  }
});

test('T-012: a corrected May-5 event invalidates prior approval and blocks re-export of the old package', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const { caseId, analyst, manager } = await deliveredCase(app);
    const drafted = await app.request('POST', `/cases/${caseId}/packages`, { token: analyst });
    const pkgId = (drafted.json as { package_id: string }).package_id;
    await app.request('POST', `/packages/${pkgId}/approve`, { token: manager });

    // New authoritative correction arrives: gate-out was actually May 5.
    const corr = await postEvent(app, analyst, caseId, {
      type: 'gate_out', local_date: '2026-05-05', supplier: 'terminal_vts', record_id: 'vts-corr-1',
    });
    assert.ok([200, 201].includes(corr.status));

    // Approval on the stale inputs refuses; export is blocked too.
    const appr2 = await app.request('POST', `/packages/${pkgId}/approve`, { token: manager });
    assert.equal(appr2.status, 409);
    const exp = await app.request('POST', `/packages/${pkgId}/export`, { token: analyst });
    assert.equal(exp.status, 409);
    assert.equal((exp.json as { error: { code: string } }).error.code, 'stale_inputs');
    const pkg = one<{ status: string }>(app.db, 'SELECT status FROM packages WHERE id = ?', pkgId)!;
    assert.equal(pkg.status, 'stale');

    // A fresh package on corrected inputs reflects INR 0 dispute… wait:
    // May 5 gate-out → expected INR 3,000 == billed → variance 0 → still packageable?
    // priced with variance 0 is a valid claim-of-none; assert the new digest differs instead.
    const calc = one<{ inputs_digest: string }>(app.db, 'SELECT inputs_digest FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1', caseId)!;
    const oldPkg = one<{ inputs_digest: string }>(app.db, 'SELECT inputs_digest FROM packages WHERE id = ?', pkgId)!;
    assert.notEqual(calc.inputs_digest, oldPkg.inputs_digest);
  } finally {
    app.close();
  }
});
