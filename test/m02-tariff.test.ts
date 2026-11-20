import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, importScene, pinDemoTariff, postEvent, SCENE_INVOICE } from './helpers.ts';
import { DEMO } from '../src/seed.ts';

test('T-003: May 4 gate-out creates exactly two chargeable dates and an INR 2,000 expected charge', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await importScene(app, analyst);
    await pinDemoTariff(app, analyst, caseId);
    assert.equal((await postEvent(app, analyst, caseId, { type: 'discharge', local_date: '2026-05-01' })).status, 200);
    assert.equal((await postEvent(app, analyst, caseId, { type: 'gate_out', local_date: '2026-05-04' })).status, 200);

    const est = await app.request('GET', `/cases/${caseId}/estimate`, { token: analyst });
    const c = est.json as {
      status: string; expected_minor: number; currency: string; tariff_version: string;
      day_breakdown: string;
    };
    assert.equal(c.status, 'priced');
    assert.equal(c.expected_minor, 200000);
    assert.equal(c.currency, 'INR');
    assert.equal(c.tariff_version, '2026-05');
    const days = (JSON.parse(c.day_breakdown) as { scenarios: { days: { date: string; kind: string }[] }[] }).scenarios[0].days;
    const chargeable = days.filter((d) => d.kind === 'chargeable');
    assert.deepEqual(chargeable.map((d) => d.date), ['2026-05-03', '2026-05-04']);
    assert.deepEqual(days.filter((d) => d.kind === 'free').map((d) => d.date), ['2026-05-01', '2026-05-02']);
  } finally {
    app.close();
  }
});

test('T-004: a missing governing tariff or undefined overlap returns unpriced, never a zero charge', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await importScene(app, analyst);
    // No tariff pinned: estimate is unpriced with an explicit missing input.
    const est1 = await app.request('POST', `/cases/${caseId}/estimate`, { token: analyst });
    const c1 = est1.json as { status: string; expected_minor: number | null; missing: string };
    assert.equal(c1.status, 'unpriced');
    assert.equal(c1.expected_minor, null);
    assert.ok(JSON.parse(c1.missing).includes('tariff'));

    // Pinned tariff whose effective range does not cover the trigger date → unpriced.
    const manager = await app.login('manager');
    const mk = await app.request('POST', '/tariffs', {
      token: manager,
      body: {
        terminal_id: 'INMAA1', version: '1999-legacy', currency: 'INR', terminal_tz: 'Asia/Kolkata',
        clock_trigger: 'discharge', free_days: 2, effective_from: '1999-01-01', effective_to: '1999-12-31',
        rate_tiers: [{ from_day: 1, to_day: null, rate_minor: 100000 }], closure_dates: [],
      },
    });
    const tid = (mk.json as { tariff_id: string }).tariff_id;
    const pin = await app.request('PUT', `/cases/${caseId}/tariff`, { token: analyst, body: { tariff_id: tid } });
    assert.equal(pin.status, 200);
    await postEvent(app, analyst, caseId, { type: 'discharge', local_date: '2026-05-01' });
    await postEvent(app, analyst, caseId, { type: 'gate_out', local_date: '2026-05-04' });
    const est2 = await app.request('GET', `/cases/${caseId}/estimate`, { token: analyst });
    const c2 = est2.json as { status: string; expected_minor: number | null };
    assert.equal(c2.status, 'unpriced');
    assert.equal(c2.expected_minor, null);
  } finally {
    app.close();
  }
});

test('M02: overlapping ambiguous version range is rejected at pin time instead of silently priced', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    // An imported case pinned to the 2025-11 tariff whose window ends 2026-04-30:
    // a May discharge sits outside every version → unpriced (not priced by a stale rate).
    const caseId = await importScene(app, analyst);
    const pin = await app.request('PUT', `/cases/${caseId}/tariff`, {
      token: analyst, body: { tariff_id: 'trf_inmaa1_2025_11' },
    });
    assert.equal(pin.status, 200);
    await postEvent(app, analyst, caseId, { type: 'discharge', local_date: '2026-05-01' });
    await postEvent(app, analyst, caseId, { type: 'gate_out', local_date: '2026-05-04' });
    const est = await app.request('GET', `/cases/${caseId}/estimate`, { token: analyst });
    assert.equal((est.json as { status: string }).status, 'unpriced');
    void DEMO;
  } finally {
    app.close();
  }
});
