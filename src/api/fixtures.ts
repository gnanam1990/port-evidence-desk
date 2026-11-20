import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db.ts';
import type { AppConfig } from '../config.ts';
import { badRequest, notFound } from '../domain/errors.ts';
import { type Actor } from '../domain/audit.ts';
import { importInvoice } from '../domain/intake.ts';

type Api = (method: string, path: string, fn: (ctx: import('../http/router.ts').RequestCtx, actor: Actor | null) => unknown, roles?: Actor['role'][]) => void;

const PILOT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'pilot',
);

/** Licensed pilot-fixture intake path: files must live in fixtures/pilot/. */
export function registerFixtureApi(api: Api, db: Db, cfg: AppConfig): void {
  api('GET', '/fixtures/pilot', () => {
    try {
      return readdirSync(PILOT_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  });

  api('POST', '/cases/import-fixture', (ctx, actor) => {
    const p = ctx as unknown as { rawBody: string };
    const body = JSON.parse(p.rawBody || '{}');
    const name = String(body.filename ?? '');
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
      throw badRequest('bad_fixture', 'filename must be a plain *.json file inside fixtures/pilot');
    }
    let raw: string;
    try {
      raw = readFileSync(path.join(PILOT_DIR, name), 'utf8');
    } catch {
      throw notFound('fixture_not_found', `no pilot fixture named ${name}`);
    }
    return importInvoice(db, {
      actor: actor!, format: 'json', filename: `pilot:${name}`, raw,
      provenance: 'pilot_fixture', maxCsvRows: cfg.maxCsvRows,
    });
  }, ['analyst']);
}
