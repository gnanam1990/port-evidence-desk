import type { Db } from '../db.ts';
import { newId, sha256Hex } from '../util/crypto.ts';
import { isoNow } from '../util/dates.ts';
import { one } from '../db.ts';

export interface Actor {
  userId: string;
  name: string;
  role: 'analyst' | 'manager' | 'accounts' | 'operator';
  tenantId: string;
}

export function audit(
  db: Db,
  entry: {
    tenantId?: string | null;
    opId?: string | null;
    actor?: string | null;
    actorRole?: string | null;
    code: string;
    detail?: unknown;
    externalRef?: string | null;
    latencyMs?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (id, tenant_id, op_id, actor, actor_role, decision_code, detail, external_ref, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('aud'),
    entry.tenantId ?? null,
    entry.opId ?? null,
    entry.actor ?? null,
    entry.actorRole ?? null,
    entry.code,
    entry.detail === undefined ? null : JSON.stringify(entry.detail),
    entry.externalRef ?? null,
    entry.latencyMs ?? null,
    isoNow(),
  );
}

export interface Operation {
  id: string;
  tenant_id: string;
  kind: string;
  idem_key: string | null;
  actor: string;
  payload_digest: string;
  status: string;
  result_ref: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * Durable idempotent operation wrapper.
 * Same tenant+kind+key with identical payload returns the stored operation.
 * Same key with a different payload is a conflict.
 */
export function runIdempotent<T extends object>(
  db: Db,
  args: { tenantId: string; kind: string; idemKey: string | null | undefined; actor: Actor; payload: unknown },
  fn: () => T,
): { operation: Operation; result: T; deduplicated: boolean } {
  const key = args.idemKey ?? null;
  const payloadDigest = sha256Hex(JSON.stringify(args.payload ?? null));
  if (key) {
    const existing = one<Operation>(
      db,
      'SELECT * FROM operations WHERE tenant_id = ? AND kind = ? AND idem_key = ?',
      args.tenantId,
      args.kind,
      key,
    );
    if (existing) {
      if (existing.payload_digest !== payloadDigest) {
        const err = new Error('idempotency key reused with a different payload');
        (err as { code?: string }).code = 'idempotency_conflict';
        throw err;
      }
      return {
        operation: existing,
        result: existing.result_ref ? (JSON.parse(existing.result_ref) as T) : ({ operation_id: existing.id } as T),
        deduplicated: true,
      };
    }
  }
  const opId = newId('op');
  db.prepare(
    `INSERT INTO operations (id, tenant_id, kind, idem_key, actor, payload_digest, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
  ).run(opId, args.tenantId, args.kind, key, args.actor.name, payloadDigest, isoNow());
  try {
    const result = fn();
    db.prepare(
      "UPDATE operations SET status = 'done', result_ref = ?, completed_at = ? WHERE id = ?",
    ).run(JSON.stringify(result), isoNow(), opId);
    const operation = one<Operation>(db, 'SELECT * FROM operations WHERE id = ?', opId)!;
    return { operation, result, deduplicated: false };
  } catch (err) {
    db.prepare("UPDATE operations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?").run(
      String((err as Error).message ?? err),
      isoNow(),
      opId,
    );
    throw err;
  }
}
