import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { makeApp, importScene, pinDemoTariff, postEvent } from './helpers.ts';
import { DEMO } from '../src/seed.ts';
import { one } from '../src/db.ts';
import { drainOutbox, recoverStuckRows } from '../src/worker.ts';

async function setupGapCase(app: Awaited<ReturnType<typeof makeApp>>) {
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
  return { caseId, gapId, analyst, manager };
}

async function quoteAndAuthorize(
  app: Awaited<ReturnType<typeof makeApp>>,
  gapId: string, manager: string, analyst: string, partnerId: string,
) {
  const q = await app.request('POST', `/gaps/${gapId}/quotes`, {
    token: analyst,
    body: { partner_id: partnerId, price_minor: 15000, asset: 'INR', expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute' },
  });
  const quoteId = (q.json as { quote_id: string }).quote_id;
  const auth = await app.request('POST', `/quotes/${quoteId}/authorize`, { token: manager });
  return auth.json as { order_id: string };
}

test('T-015: a restart during a pending partner order recovers and finishes delivery', async () => {
  const dir = mkdtempSync(path.join(process.cwd(), 'var', 'test-tmp', 'ped-restart-'));
  try {
    const app1 = await makeApp({ withWorker: false, dataDir: dir });
    const { gapId, analyst, manager } = await setupGapCase(app1);
    const { order_id } = await quoteAndAuthorize(app1, gapId, manager, analyst, DEMO.partners.localDemo);
    // Simulate a crash mid-dispatch: row stranded in 'processing'.
    drainOutbox(app1.db, app1.cfg, 0); // nothing processed
    app1.db.prepare("UPDATE outbox SET status = 'processing' WHERE kind = 'dispatch_order'").run();
    app1.close(); // preserves dataDir

    const app2 = await makeApp({ withWorker: false, dataDir: dir });
    try {
      // Startup recovery returns stranded rows to pending, then the worker completes them.
      recoverStuckRows(app2.db);
      drainOutbox(app2.db, app2.cfg); // dispatch
      drainOutbox(app2.db, app2.cfg); // auto-callback
      const order = one<{ status: string; paid: number }>(
        app2.db, 'SELECT status, paid FROM evidence_orders WHERE id = ?', order_id,
      )!;
      assert.equal(order.status, 'delivered');
      assert.equal(order.paid, 1);
      const gap = one<{ status: string }>(app2.db, 'SELECT status FROM gaps WHERE id = ?', gapId)!;
      assert.equal(gap.status, 'resolved');
    } finally {
      app2.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-016: the unverified kite route stays blocked and pilot fixtures are labeled', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const { caseId, gapId, analyst, manager } = await setupGapCase(app);
    const { order_id } = await quoteAndAuthorize(app, gapId, manager, analyst, DEMO.partners.kite);
    const order = one<{ rail: string; settlement_scope: string }>(
      app.db, 'SELECT rail, settlement_scope FROM evidence_orders WHERE id = ?', order_id,
    )!;
    assert.equal(order.rail, 'kite_session');
    assert.equal(order.settlement_scope, 'external');

    drainOutbox(app.db, app.cfg);
    const blocked = one<{ status: string; failure_reason: string; paid: number }>(
      app.db, 'SELECT status, failure_reason, paid FROM evidence_orders WHERE id = ?', order_id,
    )!;
    assert.equal(blocked.status, 'blocked_external');
    assert.equal(blocked.paid, 0); // fail closed: nothing marked settled

    // The case must not pretend delivery: no proven event appears from the blocked route.
    const ev = one<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM events WHERE case_id = ? AND type = 'gate_out'", caseId)!;
    assert.equal(ev.n, 0);
    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    assert.equal((detail.json as { recovered_minor: number }).recovered_minor, 0);

    // Pilot fixture intake: labeled and isolated from real customer evidence.
    const list = await app.request('GET', '/fixtures/pilot', { token: analyst });
    assert.ok((list.json as string[]).includes('pilot-invoice-001.json'));
    const imp = await app.request('POST', '/cases/import-fixture', {
      token: analyst, body: { filename: 'pilot-invoice-001.json' },
    });
    assert.equal(imp.status, 200);
    const pilotCase = one<{ source_class: string; invoice_ref: string }>(
      app.db, 'SELECT source_class, invoice_ref FROM cases WHERE id = ?',
      (imp.json as { case_id: string }).case_id,
    )!;
    assert.equal(pilotCase.source_class, 'pilot_fixture');
    assert.equal(pilotCase.invoice_ref, 'PILOT-INV-001');

    // A raw JSON import of the same shape is classified 'customer', not pilot.
    const real = await importScene(app, analyst);
    assert.equal(one<{ source_class: string }>(app.db, 'SELECT source_class FROM cases WHERE id = ?', real)!.source_class, 'customer');
  } finally {
    app.close();
  }
});
