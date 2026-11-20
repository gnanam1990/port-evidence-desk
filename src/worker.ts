import type { Db } from './db.ts';
import type { AppConfig } from './config.ts';
import { all, one, tx } from './db.ts';
import { isoNow } from './util/dates.ts';
import { audit } from './domain/audit.ts';
import { dispatchOrder, processPartnerCallback } from './domain/reconcile.ts';
import type { PartnerRow } from './adapters/provider.ts';
import { openDb } from './db.ts';
import { loadConfig } from './config.ts';

const MAX_ATTEMPTS = 5;

/** Recovery: a worker that died mid-row leaves 'processing' rows; reclaim them. */
export function recoverStuckRows(db: Db): number {
  return Number(
    db
      .prepare("UPDATE outbox SET status = 'pending', next_attempt_at = NULL WHERE status = 'processing'")
      .run().changes,
  );
}

function backoffMs(attempts: number): number {
  return Math.min(30_000, 250 * 2 ** attempts);
}

/**
 * Drain pending outbox rows once. Returns the number of rows finished or
 * failed. Retries are bounded; exhausted rows stay 'failed' and their orders
 * go to pending_reconciliation (no automatic redispatch).
 */
export function drainOutbox(db: Db, _cfg: AppConfig, limit = 50): number {
  let processed = 0;
  for (;;) {
    const row = one<{ id: string; kind: string; payload: string; attempts: number }>(
      db,
      `SELECT id, kind, payload, attempts FROM outbox
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT 1`,
      isoNow(),
    );
    if (!row || processed >= limit) return processed;
    tx(db, () => {
      db.prepare("UPDATE outbox SET status = 'processing', attempts = attempts + 1 WHERE id = ?").run(row.id);
    });
    processed += 1;
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (row.kind === 'dispatch_order') {
        const r = dispatchOrder(db, String(payload.order_id));
        if (!r.ok && r.status === 'pending_reconciliation') {
          throw new Error('dispatch outcome unknown; sent to pending_reconciliation');
        }
        tx(db, () => {
          db.prepare("UPDATE outbox SET status = 'done', processed_at = ? WHERE id = ?").run(isoNow(), row.id);
        });
      } else if (row.kind === 'partner_callback') {
        const partner = one<PartnerRow>(db, 'SELECT * FROM partners WHERE id = ?', String(payload.partner_id));
        if (!partner) throw new Error(`partner ${payload.partner_id} not found`);
        processPartnerCallback(db, {
          partner,
          body: String(payload.body),
          signature: typeof payload.signature === 'string' ? payload.signature : null,
        });
        tx(db, () => {
          db.prepare("UPDATE outbox SET status = 'done', processed_at = ? WHERE id = ?").run(isoNow(), row.id);
        });
      } else {
        throw new Error(`unknown outbox kind ${row.kind}`);
      }
    } catch (err) {
      const attempts = row.attempts + 1;
      tx(db, () => {
        if (attempts >= MAX_ATTEMPTS) {
          db.prepare("UPDATE outbox SET status = 'failed', last_error = ?, processed_at = ? WHERE id = ?")
            .run(String((err as Error).message ?? err), isoNow(), row.id);
        } else {
          db.prepare("UPDATE outbox SET status = 'pending', last_error = ?, next_attempt_at = ? WHERE id = ?")
            .run(
              String((err as Error).message ?? err),
              new Date(Date.now() + backoffMs(attempts)).toISOString(),
              row.id,
            );
        }
      });
    }
  }
}

export function startWorker(db: Db, cfg: AppConfig): { stop: () => void } {
  const recovered = recoverStuckRows(db);
  if (recovered > 0) {
    audit(db, { code: 'worker_recovered_rows', detail: { recovered } });
  }
  let stopped = false;
  const timer = setInterval(() => {
    try {
      drainOutbox(db, cfg);
    } catch (err) {
      console.error('worker drain error', err);
    }
  }, cfg.workerPollMs);
  timer.unref();
  return {
    stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  startWorker(db, cfg);
  console.log('worker started');
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => process.exit(0));
  }
}
