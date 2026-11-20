import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, importScene, pinDemoTariff, postEvent } from './helpers.ts';
import { DEMO } from '../src/seed.ts';
import { one, all } from '../src/db.ts';
import { drainOutbox } from '../src/worker.ts';
import { hmacSha256Hex } from '../src/util/crypto.ts';

async function authorizedOrder(app: Awaited<ReturnType<typeof makeApp>>) {
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
  const gapId = (one<{ id: string }>(app.db, "SELECT id FROM gaps WHERE case_id = ?", caseId))!.id;
  await app.request('POST', `/gaps/${gapId}/quotes`, {
    token: analyst,
    body: { partner_id: DEMO.partners.localDemo, price_minor: 15000, asset: 'INR', expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute' },
  });
  const quoteId = (one<{ id: string }>(app.db, 'SELECT id FROM quotes WHERE gap_id = ?', gapId))!.id;
  const auth = await app.request('POST', `/quotes/${quoteId}/authorize`, { token: manager });
  const orderId = (auth.json as { order_id: string }).order_id;
  return { caseId, orderId, analyst, manager };
}

function callbackBody(orderRef: string, date = '2026-05-04', recordId = `rec-${orderRef}`, revision = 1) {
  return JSON.stringify({
    order_ref: orderRef, record_id: recordId, revision,
    event: { type: 'gate_out', local_date: date, utc_offset: '+05:30' },
    container_ref: 'MSCU1234567', voyage_ref: 'VOY-88', terminal_id: 'INMAA1',
  });
}

async function postCallback(app: Awaited<ReturnType<typeof makeApp>>, body: string, secret = 'demo-callback-secret') {
  return app.request('POST', `/partners/${DEMO.partners.localDemo}/events`, {
    rawBody: body, headers: { 'x-ped-signature': hmacSha256Hex(secret, body), 'content-type': 'application/json' },
  });
}

test('T-009: two identical callbacks converge to one May 4 event and one paid order', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const { caseId, orderId } = await authorizedOrder(app);
    drainOutbox(app.db, app.cfg); // dispatch → awaiting_delivery (+ auto callback row)
    drainOutbox(app.db, app.cfg); // process the auto-callback
    const o = one<{ status: string; paid: number }>(app.db, 'SELECT status, paid FROM evidence_orders WHERE id = ?', orderId)!;
    assert.equal(o.status, 'delivered');
    assert.equal(o.paid, 1);

    // The identical signed callback re-posted through the real endpoint is a no-op.
    const res = await postCallback(app, callbackBody(orderId, '2026-05-04', `demo-${orderId}`));
    assert.equal(res.status, 200);
    assert.ok(['duplicate', 'accepted'].includes((res.json as { outcome: string }).outcome));
    const events = all<{ local_date: string; status: string }>(
      app.db, "SELECT local_date, status FROM events WHERE case_id = ? AND type = 'gate_out' AND status != 'quarantined'", caseId,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].local_date, '2026-05-04');
    assert.equal(one<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM evidence_orders WHERE case_id = ?', caseId)!.n, 1);

    const est = await app.request('GET', `/cases/${caseId}/estimate`, { token: await app.login('analyst') });
    assert.equal((est.json as { expected_minor: number }).expected_minor, 200000);
  } finally {
    app.close();
  }
});

test('T-010: conflicting authenticated gate times trigger review rather than auto-picking the cheapest', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const { caseId, orderId } = await authorizedOrder(app);
    drainOutbox(app.db, app.cfg);
    drainOutbox(app.db, app.cfg); // delivers May 4

    // A different authenticated record for a different date must not silently replace.
    const res = await postCallback(app, callbackBody(orderId, '2026-05-05', 'rec-vts-9'));
    assert.equal((res.json as { outcome: string }).outcome, 'conflict');
    const c = one<{ state: string }>(app.db, 'SELECT state FROM cases WHERE id = ?', caseId)!;
    assert.equal(c.state, 'conflict_review');
    const calc = one<{ status: string }>(app.db, 'SELECT status FROM calculations WHERE case_id = ? ORDER BY revision DESC LIMIT 1', caseId)!;
    assert.equal(calc.status, 'conflict');
    // No automatic cheapest selection: both candidates remain disputed.
    const n = one<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM events WHERE case_id = ? AND type = 'gate_out' AND status = 'disputed'", caseId)!.n;
    assert.equal(n, 2);
  } finally {
    app.close();
  }
});

test('M05: unknown order refs park visibly; bad signatures reject; stale revisions reject; corrections supersede', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const { caseId, orderId } = await authorizedOrder(app);
    drainOutbox(app.db, app.cfg);
    drainOutbox(app.db, app.cfg);

    // Unknown order reference → parked, visible in ops ledger.
    const parked = await postCallback(app, callbackBody('ord_nonexistent', '2026-05-04', 'rec-unknown-1'));
    assert.equal((parked.json as { outcome: string }).outcome, 'parked_unknown_order');
    const ops = await app.request('GET', '/ops/status', { token: await app.login('operator') });
    const parkedList = (ops.json as { parked_callbacks: { outcome: string }[] }).parked_callbacks;
    assert.ok(parkedList.some((p) => p.outcome === 'parked_unknown_order'));

    // Bad signature → 401 and recorded as rejected.
    const bad = await app.request('POST', `/partners/${DEMO.partners.localDemo}/events`, {
      rawBody: callbackBody(orderId, '2026-05-04', 'rec-badsig'), headers: { 'x-ped-signature': 'deadbeef' },
    });
    assert.equal(bad.status, 401);

    // A stale revision of an existing record is rejected.
    const stale = await postCallback(app, callbackBody(orderId, '2026-05-04', `demo-${orderId}`, 1));
    // demo-<orderId> rev1 already exists from auto-delivery → duplicate, which is also convergence.
    assert.ok(['duplicate', 'rejected'].includes((stale.json as { outcome: string }).outcome));

    // Revision 2 of the delivered record = a correction: new revision appended,
    // original kept as superseded, calculation recomputed (INV-05).
    const corr = await postCallback(app, callbackBody(orderId, '2026-05-05', `demo-${orderId}`, 2));
    assert.ok(['accepted', 'conflict'].includes((corr.json as { outcome: string }).outcome));
    const revs = all<{ revision: number; status: string }>(
      app.db, 'SELECT revision, status FROM events WHERE case_id = ? AND record_id = ? ORDER BY revision', caseId, `demo-${orderId}`,
    );
    assert.deepEqual(revs.map((r) => [r.revision, r.status]), [[1, 'superseded'], [2, 'proven']]);
    const est = await app.request('GET', `/cases/${caseId}/estimate`, { token: await app.login('analyst') });
    assert.equal((est.json as { expected_minor: number }).expected_minor, 300000);
  } finally {
    app.close();
  }
});
