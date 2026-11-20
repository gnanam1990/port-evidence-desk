import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, importScene, pinDemoTariff, postEvent } from './helpers.ts';
import { DEMO } from '../src/seed.ts';
import { one } from '../src/db.ts';

async function caseWithGap(app: Awaited<ReturnType<typeof makeApp>>, analyst: string) {
  const caseId = await importScene(app, analyst);
  await pinDemoTariff(app, analyst, caseId);
  await postEvent(app, analyst, caseId, { type: 'discharge', local_date: '2026-05-01' });
  await app.request('POST', `/cases/${caseId}/gaps`, {
    token: analyst,
    body: { required_event: 'gate_out', plausible_from: '2026-05-04', plausible_to: '2026-05-05', bound_reason: 'availability window' },
  });
  const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
  const gap = (detail.json as { gaps: { id: string }[] }).gaps[0];
  return { caseId, gapId: gap.id };
}

async function setBudget(app: Awaited<ReturnType<typeof makeApp>>, manager: string, caseId: string, minor = 20000) {
  const res = await app.request('POST', `/cases/${caseId}/budget`, {
    token: manager, body: { ceiling_minor: minor, asset: 'INR', policy_ref: 'POL-EV-01 investigate 0..1000' },
  });
  assert.equal(res.status, 200);
}

test('T-007: a comparable INR 150 quote under the INR 200 ceiling emits one authorized order', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const manager = await app.login('manager');
    const { caseId, gapId } = await caseWithGap(app, analyst);
    await setBudget(app, manager, caseId);
    const q = await app.request('POST', `/gaps/${gapId}/quotes`, {
      token: analyst,
      body: {
        partner_id: DEMO.partners.localDemo, price_minor: 15000, asset: 'INR',
        expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute',
      },
    });
    assert.equal(q.status, 200);
    const quoteId = (q.json as { quote_id: string }).quote_id;

    const auth = await app.request('POST', `/quotes/${quoteId}/authorize`, {
      token: manager, headers: { 'idempotency-key': 'auth-1' },
    });
    assert.equal(auth.status, 200);
    const order = auth.json as { order_id: string; status: string; rail: string; settlement_scope: string };
    assert.equal(order.status, 'authorized');
    assert.equal(order.rail, 'local_demo');
    assert.equal(order.settlement_scope, 'local_demo');

    // Duplicate click with the same key replays; a fresh attempt hits the live-order guard.
    const replay = await app.request('POST', `/quotes/${quoteId}/authorize`, {
      token: manager, headers: { 'idempotency-key': 'auth-1' },
    });
    assert.equal(replay.status, 200);
    const count = one<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM evidence_orders WHERE case_id = ?', caseId)!.n;
    assert.equal(count, 1);
    void replay;
  } finally {
    app.close();
  }
});

test('T-008: an expired conversion or INR 201 quote cannot dispatch, including after duplicate clicks', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const manager = await app.login('manager');
    const { caseId, gapId } = await caseWithGap(app, analyst);
    await setBudget(app, manager, caseId);

    // Over-ceiling quote: denied with an explicit reason; no order created.
    const q201 = await app.request('POST', `/gaps/${gapId}/quotes`, {
      token: analyst,
      body: { partner_id: DEMO.partners.localDemo, price_minor: 20100, asset: 'INR', expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute' },
    });
    const denied = await app.request('POST', `/quotes/${(q201.json as { quote_id: string }).quote_id}/authorize`, {
      token: manager, headers: { 'idempotency-key': 'deny-1' },
    });
    assert.equal(denied.status, 422);
    const reasons = (denied.json as { error: { detail: { reasons: string[] } } }).error.detail.reasons;
    assert.ok(reasons.includes('over_ceiling'));
    const deniedReplay = await app.request('POST', `/quotes/${(q201.json as { quote_id: string }).quote_id}/authorize`, {
      token: manager, headers: { 'idempotency-key': 'deny-1' },
    });
    // Same key + same payload replays the stored denial outcome as a conflict-free no-op? No:
    // failed operations do not store results, so this re-executes and denies again identically.
    assert.equal(deniedReplay.status, 422);

    // Token-denominated quote with an expired pinned conversion (INV-04).
    const qTok = await app.request('POST', `/gaps/${gapId}/quotes`, {
      token: analyst,
      body: {
        partner_id: DEMO.partners.localDemo, price_minor: 150, asset: 'XTOK',
        expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute',
        conversion: {
          rate_num: 100, rate_den: 1, to_asset: 'INR',
          pinned_at: '2026-01-01T00:00:00Z', valid_until: '2026-02-01T00:00:00Z', source: 'fx-oracle-demo',
        },
      },
    });
    const deniedConv = await app.request('POST', `/quotes/${(qTok.json as { quote_id: string }).quote_id}/authorize`, {
      token: manager,
    });
    assert.equal(deniedConv.status, 422);
    assert.ok((deniedConv.json as { error: { detail: { reasons: string[] } } }).error.detail.reasons.includes('conversion_expired'));

    // Token quote with no conversion at all: cannot compare, must block.
    const qTok2 = await app.request('POST', `/gaps/${gapId}/quotes`, {
      token: analyst,
      body: { partner_id: DEMO.partners.localDemo, price_minor: 150, asset: 'XTOK', expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute' },
    });
    const deniedNoConv = await app.request('POST', `/quotes/${(qTok2.json as { quote_id: string }).quote_id}/authorize`, { token: manager });
    assert.equal(deniedNoConv.status, 422);
    assert.ok((deniedNoConv.json as { error: { detail: { reasons: string[] } } }).error.detail.reasons.includes('conversion_required'));

    assert.equal(one<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM evidence_orders WHERE case_id = ?', caseId)!.n, 0);
  } finally {
    app.close();
  }
});

test('M04: a token quote with a valid pinned conversion is compared in case currency', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const manager = await app.login('manager');
    const { caseId, gapId } = await caseWithGap(app, analyst);
    await setBudget(app, manager, caseId);
    const q = await app.request('POST', `/gaps/${gapId}/quotes`, {
      token: analyst,
      body: {
        partner_id: DEMO.partners.localDemo, price_minor: 150, asset: 'XTOK',
        expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute',
        conversion: {
          rate_num: 100, rate_den: 1, to_asset: 'INR',
          pinned_at: '2026-01-01T00:00:00Z', valid_until: '2999-01-01T00:00:00Z', source: 'fx-oracle-demo',
        },
      },
    });
    const auth = await app.request('POST', `/quotes/${(q.json as { quote_id: string }).quote_id}/authorize`, { token: manager });
    assert.equal(auth.status, 200);
    const o = one<{ converted_ceiling_minor: number | null; conversion_ref: string | null }>(
      app.db, 'SELECT converted_ceiling_minor, conversion_ref FROM evidence_orders WHERE case_id = ?', caseId,
    )!;
    assert.equal(o.converted_ceiling_minor, 15000); // 150 XTOK × 100 → 15,000 INR paise
    assert.ok(o.conversion_ref?.includes('fx-oracle-demo'));
  } finally {
    app.close();
  }
});

test('M04: no budget → authorization denied; internal_only rights → denied', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const manager = await app.login('manager');
    const { caseId, gapId } = await caseWithGap(app, analyst);
    const q1 = await app.request('POST', `/gaps/${gapId}/quotes`, {
      token: analyst,
      body: { partner_id: DEMO.partners.localDemo, price_minor: 15000, asset: 'INR', expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'attach_to_dispute' },
    });
    const d1 = await app.request('POST', `/quotes/${(q1.json as { quote_id: string }).quote_id}/authorize`, { token: manager });
    assert.equal(d1.status, 422);
    assert.ok((d1.json as { error: { detail: { reasons: string[] } } }).error.detail.reasons.includes('no_case_budget'));

    await setBudget(app, manager, caseId);
    const q2 = await app.request('POST', `/gaps/${gapId}/quotes`, {
      token: analyst,
      body: { partner_id: DEMO.partners.localDemo, price_minor: 15000, asset: 'INR', expires_at: '2026-12-31T00:00:00Z', redistribution_rights: 'internal_only' },
    });
    const d2 = await app.request('POST', `/quotes/${(q2.json as { quote_id: string }).quote_id}/authorize`, { token: manager });
    assert.equal(d2.status, 422);
    assert.ok((d2.json as { error: { detail: { reasons: string[] } } }).error.detail.reasons.includes('rights_do_not_permit_dispute_use'));
  } finally {
    app.close();
  }
});
