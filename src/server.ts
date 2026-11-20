import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { buildHandler } from './http/app.ts';
import { seedDemo, isSeeded } from './seed.ts';
import { startWorker } from './worker.ts';

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
if (!isSeeded(db)) seedDemo(db);

const handler = buildHandler(db, cfg);
const server = createServer(handler);
server.listen(cfg.port, () => {
  console.log(`port-evidence-desk listening on http://localhost:${cfg.port}`);
});

// In-process supervised worker; run `npm run worker` for a separate process.
const worker = startWorker(db, cfg);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    worker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
