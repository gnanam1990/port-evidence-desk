import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, importScene, pinDemoTariff, postEvent } from './helpers.ts';

async function sceneWithGap(app: Awaited<ReturnType<typeof makeApp>>, analyst: string) {
  const caseId = await importScene(app, analyst);
  await pinDemoTariff(app, analyst, caseId);
  assert.equal((await postEvent(app, analyst, caseId, { type: 'discharge', local_date: '2026-05-01' })).status, 200);
  return caseId;
}

test('T-005: a May 4–5 bounded gap yields INR 0–1,000 potential dispute and no received credit', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await sceneWithGap(app, analyst);
    const gapRes = await app.request('POST', `/cases/${caseId}/gaps`, {
      token: analyst,
      body: { required_event: 'gate_out', plausible_from: '2026-05-04', plausible_to: '2026-05-05', bound_reason: 'terminal availability window' },
    });
    assert.equal(gapRes.status, 200);

    const est = await app.request('GET', `/cases/${caseId}/estimate`, { token: analyst });
    const c = est.json as {
      status: string; expected_min_minor: number; expected_max_minor: number;
      variance_min_minor: number; variance_max_minor: number; day_breakdown: string;
    };
    assert.equal(c.status, 'bounded_estimate');
    assert.equal(c.expected_min_minor, 200000);
    assert.equal(c.expected_max_minor, 300000);
    assert.equal(c.variance_min_minor, 0);
    assert.equal(c.variance_max_minor, 100000);
    const scenarios = (JSON.parse(c.day_breakdown) as { scenarios: { gate_out_date: string; expected_minor: number }[] }).scenarios;
    assert.deepEqual(scenarios.map((s) => [s.gate_out_date, s.expected_minor]), [['2026-05-04', 200000], ['2026-05-05', 300000]]);

    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    const d = detail.json as { gaps: { uncertainty_min_minor: number; uncertainty_max_minor: number }[]; credits: unknown[]; state: string };
    assert.equal(d.gaps[0].uncertainty_min_minor, 0);
    assert.equal(d.gaps[0].uncertainty_max_minor, 100000);
    assert.equal(d.credits.length, 0); // INV-03: potential dispute ≠ received credit
    assert.equal(d.state, 'evidence_gap');
  } finally {
    app.close();
  }
});

test('T-006: a gate-out record for the same container on a different voyage is quarantined', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await sceneWithGap(app, analyst);
    const res = await postEvent(app, analyst, caseId, {
      type: 'gate_out', local_date: '2026-05-04', record_id: 'foreign-1',
      container_ref: 'MSCU1234567', voyage_ref: 'VOY-OTHER', terminal_id: 'INMAA1',
    });
    assert.equal(res.status, 200);
    assert.equal((res.json as { outcome: string }).outcome, 'quarantined');

    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    const d = detail.json as { events: { record_id: string; status: string }[]; latest_calculation: { status: string } | null };
    const foreign = d.events.find((e) => e.record_id === 'foreign-1');
    assert.equal(foreign?.status, 'quarantined');
    // Quarantined records never feed the calculation.
    assert.notEqual(d.latest_calculation?.status, 'priced');
  } finally {
    app.close();
  }
});

test('M03: two usable gate-out records on different dates trigger review, not the cheapest outcome', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await sceneWithGap(app, analyst);
    assert.equal((await postEvent(app, analyst, caseId, { type: 'gate_out', local_date: '2026-05-04', record_id: 'r-a', supplier: 'terminal' })).status, 200);
    const conflict = await postEvent(app, analyst, caseId, { type: 'gate_out', local_date: '2026-05-05', record_id: 'r-b', supplier: 'vts' });
    assert.equal((conflict.json as { outcome: string }).outcome, 'conflict');

    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    const d = detail.json as {
      state: string; latest_calculation: { status: string };
      open_conflicts: { id: string; detail: string }[];
    };
    assert.equal(d.state, 'conflict_review');
    assert.equal(d.latest_calculation.status, 'conflict');
    const candidates = JSON.parse(d.open_conflicts[0].detail) as { candidates: string[] };

    // Manual resolution picks the winner; the loser stays traceable as superseded.
    const events = (await app.request('GET', `/cases/${caseId}`, { token: analyst })).json as {
      events: { id: string; record_id: string; local_date: string }[];
    };
    const winner = events.events.find((e) => e.record_id === 'r-a')!;
    const manager = await app.login('manager');
    const res = await app.request('POST', `/conflicts/${d.open_conflicts[0].id}/resolve-event`, {
      token: manager, body: { winner_event_id: winner.id, reason: 'terminal authority confirmed May 4' },
    });
    assert.equal(res.status, 200);
    void candidates;
    const est = await app.request('GET', `/cases/${caseId}/estimate`, { token: analyst });
    assert.equal((est.json as { status: string; expected_minor: number }).status, 'priced');
    assert.equal((est.json as { expected_minor: number }).expected_minor, 200000);
  } finally {
    app.close();
  }
});
