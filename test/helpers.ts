import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { loadConfig, type AppConfig } from '../src/config.ts';
import { openDb, type Db } from '../src/db.ts';
import { buildHandler } from '../src/http/app.ts';
import { seedDemo, DEMO } from '../src/seed.ts';
import { hmacSha256Hex } from '../src/util/crypto.ts';
import { startWorker } from '../src/worker.ts';

export interface TestApp {
  db: Db;
  cfg: AppConfig;
  base: string;
  server: Server;
  dir: string;
  stopWorker: () => void;
  request: (
    method: string, path: string,
    opts?: { token?: string; body?: unknown; headers?: Record<string, string>; rawBody?: string },
  ) => Promise<{ status: number; json: unknown; headers: Record<string, string> }>;
  login: (name: keyof typeof DEMO.users) => Promise<string>;
  signCallback: (partnerId: string, body: string) => string;
  close: () => void;
}

export async function makeApp(opts: { withWorker?: boolean; dataDir?: string } = {}): Promise<TestApp> {
  let dir: string;
  let ownDir = true;
  if (opts.dataDir) {
    dir = opts.dataDir;
    mkdirSync(dir, { recursive: true });
    ownDir = false;
  } else {
    const tmpRoot = path.join(process.cwd(), 'var', 'test-tmp');
    mkdirSync(tmpRoot, { recursive: true });
    dir = mkdtempSync(path.join(tmpRoot, 'ped-test-'));
  }
  const cfg: AppConfig = {
    ...loadConfig(),
    dbPath: path.join(dir, 'test.db'),
    exportDir: path.join(dir, 'exports'),
    port: 0,
    maxBodyBytes: 64 * 1024,
    maxCsvRows: 200,
    workerPollMs: 50,
  };
  const db = openDb(cfg.dbPath);
  seedDemo(db);
  const server = createServer(buildHandler(db, cfg));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const worker = opts.withWorker === false ? null : startWorker(db, cfg);

  const app: TestApp = {
    db, cfg, base, server, dir,
    stopWorker: () => worker?.stop(),
    async request(method, p, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      let body: string | undefined;
      if (opts.rawBody !== undefined) {
        body = opts.rawBody;
      } else if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers['content-type'] = 'application/json';
      }
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const res = await fetch(`${base}${p}`, { method, headers, body });
      const text = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = { __text: text }; }
      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => { hdrs[k] = v; });
      return { status: res.status, json, headers: hdrs };
    },
    async login(name) {
      const u = DEMO.users[name];
      const res = await app.request('POST', '/sessions', { body: { name: u.name, pin: u.pin } });
      return (res.json as { token: string }).token;
    },
    signCallback(partnerId, body) {
      const secret = partnerId === DEMO.partners.kite ? 'kite-callback-secret' : 'demo-callback-secret';
      return hmacSha256Hex(secret, body);
    },
    close() {
      worker?.stop();
      server.close();
      db.close();
      if (ownDir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return app;
}

/** The shared acceptance-scene invoice (INR 3,000 demurrage, May window). */
export const SCENE_INVOICE = JSON.stringify({
  invoice_ref: 'INV-7741', container_ref: 'MSCU1234567', voyage_ref: 'VOY-88',
  terminal_id: 'INMAA1', currency: 'INR',
  charge_lines: [{ service: 'import_demurrage', billed_minor: 300000, period_start: '2026-05-03', period_end: '2026-05-05' }],
});

export const SCENE_CSV = [
  'invoice_ref,container_ref,voyage_ref,terminal_id,currency,service,billed_minor,period_start,period_end',
  'INV-7741,MSCU1234567,VOY-88,INMAA1,INR,import_demurrage,300000,2026-05-03,2026-05-05',
].join('\n');

export async function importScene(app: TestApp, analystToken: string, raw = SCENE_INVOICE): Promise<string> {
  const res = await app.request('POST', '/cases/import', {
    token: analystToken,
    body: { format: 'json', filename: 'scene.json', content: raw },
  });
  if (res.status !== 200) throw new Error(`import failed: ${JSON.stringify(res.json)}`);
  return (res.json as { case_id: string }).case_id;
}

export async function pinDemoTariff(app: TestApp, analystToken: string, caseId: string): Promise<void> {
  const res = await app.request('PUT', `/cases/${caseId}/tariff`, {
    token: analystToken, body: { tariff_id: DEMO.tariffs.inmaa1May },
  });
  if (res.status !== 200) throw new Error(`pin failed: ${JSON.stringify(res.json)}`);
}

export async function postEvent(
  app: TestApp, analystToken: string, caseId: string,
  ev: { type: string; local_date: string; utc_offset?: string; record_id?: string; revision?: number; supplier?: string; container_ref?: string; voyage_ref?: string; terminal_id?: string },
) {
  return app.request('POST', `/cases/${caseId}/events`, { token: analystToken, body: ev });
}
