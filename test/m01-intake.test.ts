import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, SCENE_INVOICE, SCENE_CSV, importScene } from './helpers.ts';

test('T-001: importing the INR 3,000 invoice twice yields one case with one source digest', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await importScene(app, analyst);
    const again = await app.request('POST', '/cases/import', {
      token: analyst, body: { format: 'json', filename: 'scene.json', content: SCENE_INVOICE },
    });
    assert.equal(again.status, 200);
    const second = again.json as { case_id: string; deduplicated: boolean; revision: number };
    assert.equal(second.case_id, caseId);
    assert.equal(second.deduplicated, true);

    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    const d = detail.json as { invoice_documents: unknown[]; charge_lines: unknown[] };
    assert.equal(d.invoice_documents.length, 1);
    assert.equal(d.charge_lines.length, 1);
  } finally {
    app.close();
  }
});

test('T-002: the same invoice key with a changed amount opens a conflicting revision for review', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await importScene(app, analyst);
    const changed = SCENE_INVOICE.replace('300000', '450000');
    const res = await app.request('POST', '/cases/import', {
      token: analyst, body: { format: 'json', filename: 'scene-v2.json', content: changed },
    });
    assert.equal(res.status, 409);
    const err = res.json as { error: { code: string; detail: { conflict_id: string } } };
    assert.equal(err.error.code, 'invoice_revision_conflict');
    assert.ok(err.error.detail.conflict_id);

    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    const d = detail.json as {
      state: string; invoice_documents: { revision: number; status: string }[];
      charge_lines: { billed_minor: number }[]; open_conflicts: { id: string; kind: string }[];
    };
    assert.equal(d.state, 'conflict_review');
    assert.equal(d.invoice_documents.length, 2);
    assert.equal(d.invoice_documents[1].status, 'conflict');
    // Original charge line is untouched (no silent second line, INV-01).
    assert.equal(d.charge_lines.length, 1);
    assert.equal(d.charge_lines[0].billed_minor, 300000);
    assert.equal(d.open_conflicts.length, 1);

    // Resolve toward the new revision: charge lines follow the winner.
    const manager = await app.login('manager');
    const fix = await app.request('POST', `/conflicts/${err.error.detail.conflict_id}/resolve-invoice`, {
      token: manager, body: { revision: 2, reason: 'carrier issued a corrected invoice' },
    });
    assert.equal(fix.status, 200);
    const after = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    const a = after.json as { charge_lines: { billed_minor: number }[]; open_conflicts: unknown[] };
    assert.equal(a.charge_lines[0].billed_minor, 450000);
    assert.equal(a.open_conflicts.length, 0);
  } finally {
    app.close();
  }
});

test('M01: bounded CSV parses to the same normalized case; oversized input is rejected', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const res = await app.request('POST', '/cases/import', {
      token: analyst, body: { format: 'csv', filename: 'inv.csv', content: SCENE_CSV },
    });
    assert.equal(res.status, 200);
    const caseId = (res.json as { case_id: string }).case_id;
    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    const d = detail.json as { invoice_ref: string; charge_lines: { billed_minor: number }[] };
    assert.equal(d.invoice_ref, 'INV-7741');
    assert.equal(d.charge_lines[0].billed_minor, 300000);

    const tooMany = 'invoice_ref,container_ref,voyage_ref,terminal_id,currency,service,billed_minor,period_start,period_end\n'
      + Array.from({ length: 300 }, (_, i) => `INV-${i},C${i},V${i},INMAA1,INR,x,1,2026-05-01,2026-05-02`).join('\n');
    const big = await app.request('POST', '/cases/import', {
      token: analyst, body: { format: 'csv', filename: 'big.csv', content: tooMany },
    });
    assert.equal(big.status, 400);
    assert.equal((big.json as { error: { code: string } }).error.code, 'csv_too_many_rows');
  } finally {
    app.close();
  }
});

test('M01: missing required identity and bad amounts are rejected; roles are enforced', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const missing = await app.request('POST', '/cases/import', {
      token: analyst, body: { format: 'json', filename: 'x', content: JSON.stringify({ invoice_ref: 'X', currency: 'INR', charge_lines: [{ service: 'd', billed_minor: 1 }] }) },
    });
    assert.equal(missing.status, 400);

    const badAmount = await app.request('POST', '/cases/import', {
      token: analyst, body: { format: 'json', filename: 'x', content: JSON.stringify({
        invoice_ref: 'INV-BAD', container_ref: 'C1', voyage_ref: 'V1', terminal_id: 'INMAA1', currency: 'INR',
        charge_lines: [{ service: 'd', billed_minor: '12.345' }],
      }) },
    });
    assert.equal(badAmount.status, 400);

    const accounts = await app.login('accounts');
    const denied = await app.request('POST', '/cases/import', {
      token: accounts, body: { format: 'json', filename: 'x', content: SCENE_INVOICE },
    });
    assert.equal(denied.status, 403);

    const noAuth = await app.request('POST', '/cases/import', {
      body: { format: 'json', filename: 'x', content: SCENE_INVOICE },
    });
    assert.equal(noAuth.status, 401);
  } finally {
    app.close();
  }
});

test('M01: tenant isolation — a second tenant cannot read the case', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const caseId = await importScene(app, analyst);
    const outsider = await app.login('otherAnalyst');
    const res = await app.request('GET', `/cases/${caseId}`, { token: outsider });
    assert.equal(res.status, 404);
  } finally {
    app.close();
  }
});
