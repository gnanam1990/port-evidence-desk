import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, importScene, pinDemoTariff, postEvent } from './helpers.ts';
import { one } from '../src/db.ts';

async function postCredit(
  app: Awaited<ReturnType<typeof makeApp>>, token: string, caseId: string,
  body: Record<string, unknown>, key?: string,
) {
  return app.request('POST', `/cases/${caseId}/credits`, {
    token, body, headers: key ? { 'idempotency-key': key } : undefined,
  });
}

test('T-013: a duplicated INR 700 carrier credit does not double-count recovery', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const accounts = await app.login('accounts');
    const caseId = await importScene(app, analyst);

    const c1 = await postCredit(app, accounts, caseId, {
      reference: 'CRN-7741-001', amount_minor: 70000, currency: 'INR', effective_on: '2026-05-20',
    }, 'credit-1');
    assert.equal(c1.status, 200);
    assert.equal((c1.json as { recovered_total_minor: number }).recovered_total_minor, 70000);

    // Same key replays; same reference under a new key dedupes at the domain level.
    const c1r = await postCredit(app, accounts, caseId, {
      reference: 'CRN-7741-001', amount_minor: 70000, currency: 'INR', effective_on: '2026-05-20',
    }, 'credit-1');
    assert.equal((c1r.json as { replayed: boolean }).replayed, true);
    const c2 = await postCredit(app, accounts, caseId, {
      reference: 'CRN-7741-001', amount_minor: 70000, currency: 'INR', effective_on: '2026-05-20',
    }, 'credit-2');
    assert.equal((c2.json as { deduplicated: boolean }).deduplicated, true);
    assert.equal((c2.json as { recovered_total_minor: number }).recovered_total_minor, 70000);
    assert.equal(one<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM credits WHERE case_id = ?', caseId)!.n, 1);

    // The case shows actual recovery only after the credit, and the portfolio
    // separates disputed/submitted/credited values.
    const detail = await app.request('GET', `/cases/${caseId}`, { token: analyst });
    assert.equal((detail.json as { recovered_minor: number }).recovered_minor, 70000);
  } finally {
    app.close();
  }
});

test('T-014: credits in another currency or another tenant are rejected', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const accounts = await app.login('accounts');
    const ravi = await app.login('otherAnalyst');
    const caseId = await importScene(app, analyst);

    const usd = await postCredit(app, accounts, caseId, {
      reference: 'CRN-USD-1', amount_minor: 1000, currency: 'USD', effective_on: '2026-05-20',
    });
    assert.equal(usd.status, 422);
    assert.equal((usd.json as { error: { code: string } }).error.code, 'currency_mismatch');

    // A non-accounts role cannot post credits at all.
    const wrongRole = await postCredit(app, analyst, caseId, {
      reference: 'CRN-X', amount_minor: 100, currency: 'INR', effective_on: '2026-05-20',
    });
    assert.equal(wrongRole.status, 403);

    // Another tenant cannot see the case, let alone credit it.
    const cross = await postCredit(app, ravi, caseId, {
      reference: 'CRN-CROSS', amount_minor: 100, currency: 'INR', effective_on: '2026-05-20',
    });
    assert.equal(cross.status, 403); // ravi is an analyst → role gate before tenant check
    assert.equal(one<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM credits')!.n, 0);
  } finally {
    app.close();
  }
});

test('M07: portfolio report separates disputed, submitted and credited per currency', async () => {
  const app = await makeApp({ withWorker: false });
  try {
    const analyst = await app.login('analyst');
    const manager = await app.login('manager');
    const accounts = await app.login('accounts');
    const caseId = await importScene(app, analyst);

    // Price the case so disputed shows up.
    await pinDemoTariff(app, analyst, caseId);
    await postEvent(app, analyst, caseId, { type: 'discharge', local_date: '2026-05-01' });
    await postEvent(app, analyst, caseId, { type: 'gate_out', local_date: '2026-05-04', supplier: 'terminal_vts' });
    void manager;

    const before = await app.request('GET', '/portfolio', { token: accounts });
    const inr = (before.json as { totals: { currency: string; disputed_minor: number; submitted_minor: number; credited_minor: number }[] }).totals.find((t) => t.currency === 'INR')!;
    assert.equal(inr.disputed_minor, 100000); // potential dispute 1,000
    assert.equal(inr.credited_minor, 0);

    await postCredit(app, accounts, caseId, {
      reference: 'CRN-7741-001', amount_minor: 70000, currency: 'INR', effective_on: '2026-05-20',
    });
    const after = await app.request('GET', '/portfolio', { token: accounts });
    const inr2 = (after.json as { totals: { currency: string; disputed_minor: number; credited_minor: number }[] }).totals.find((t) => t.currency === 'INR')!;
    assert.equal(inr2.credited_minor, 70000);
  } finally {
    app.close();
  }
});
