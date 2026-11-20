import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { one } from '../db.ts';
import { notFound } from '../domain/errors.ts';
import { runIdempotent, type Actor } from '../domain/audit.ts';
import { createPackage, approvePackage, exportPackage } from '../domain/packages.ts';

type Api = (method: string, path: string, fn: (ctx: import('../http/router.ts').RequestCtx, actor: Actor | null) => unknown, roles?: Actor['role'][]) => void;

export function registerPackageApi(api: Api, db: Db, cfg: AppConfig): void {
  api('POST', '/cases/:id/packages', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string> };
    return createPackage(db, { actor: actor!, caseId: p.params.id });
  }, ['analyst']);

  api('POST', '/packages/:id/approve', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string> };
    return approvePackage(db, { actor: actor!, packageId: p.params.id });
  }, ['manager']);

  api('POST', '/packages/:id/export', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string>; headers: Record<string, string | string[] | undefined> };
    const { operation, result, deduplicated } = runIdempotent(
      db,
      {
        tenantId: actor!.tenantId, kind: 'packages.export',
        idemKey: p.headers['idempotency-key'] as string | undefined,
        actor: actor!, payload: { package_id: p.params.id },
      },
      () => exportPackage(db, { actor: actor!, packageId: p.params.id, exportDir: cfg.exportDir }),
    );
    return { ...result, operation_id: operation.id, replayed: deduplicated };
  }, ['analyst', 'manager']);

  api('GET', '/packages/:id/manifest', (ctx, actor) => {
    const p = ctx as unknown as { params: Record<string, string> };
    const pkg = one<{ id: string; case_id: string; export_dir: string | null; status: string; manifest_sha: string | null }>(
      db, 'SELECT * FROM packages WHERE id = ?', p.params.id,
    );
    if (!pkg) throw notFound('package_not_found', 'package not found');
    const cs = one<{ tenant_id: string }>(db, 'SELECT tenant_id FROM cases WHERE id = ?', pkg.case_id);
    if (!cs || cs.tenant_id !== actor!.tenantId) throw notFound('package_not_found', 'package not found');
    if (!pkg.export_dir || !existsSync(path.join(pkg.export_dir, 'manifest.json'))) {
      throw notFound('not_exported', 'package has not been exported');
    }
    return {
      manifest_sha: pkg.manifest_sha,
      manifest: JSON.parse(readFileSync(path.join(pkg.export_dir, 'manifest.json'), 'utf8')),
    };
  });
}
