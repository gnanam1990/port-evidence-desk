/**
 * Demo seed: two tenants (for isolation checks), four roles, the May-2026
 * INMAA1 demo tariff and two labeled partner records. The local-demo partner
 * is a team-controlled fake merchant; the kite partner is deliberately
 * capability-blocked until a real authorized route exists.
 * Demo pins are for local development only.
 */
import type { Db } from './db.ts';
import { one } from './db.ts';
import { isoNow } from './util/dates.ts';
import { openDb } from './db.ts';
import { loadConfig } from './config.ts';

export const DEMO = {
  tenants: { fwd: 't_fwd1', other: 't_other' },
  users: {
    analyst: { name: 'aisha', pin: 'analyst-demo-pin', role: 'analyst' },
    manager: { name: 'mohan', pin: 'manager-demo-pin', role: 'manager' },
    accounts: { name: 'priya', pin: 'accounts-demo-pin', role: 'accounts' },
    operator: { name: 'ops', pin: 'ops-demo-pin', role: 'operator' },
    otherAnalyst: { name: 'ravi', pin: 'ravi-demo-pin', role: 'analyst' },
  },
  partners: {
    localDemo: 'ptr_demo_coop',
    kite: 'ptr_kite_terminal',
  },
  tariffs: { inmaa1May: 'trf_inmaa1_2026_05' },
} as const;

export function seedDemo(db: Db): void {
  const now = isoNow();
  const insTenant = db.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)');
  insTenant.run(DEMO.tenants.fwd, 'Forwarder One (demo tenant)', now);
  insTenant.run(DEMO.tenants.other, 'Second Forwarder (isolation test tenant)', now);

  const insUser = db.prepare(
    'INSERT OR IGNORE INTO users (id, tenant_id, name, role, pin, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const u = DEMO.users;
  insUser.run('usr_aisha', DEMO.tenants.fwd, u.analyst.name, 'analyst', u.analyst.pin, now);
  insUser.run('usr_mohan', DEMO.tenants.fwd, u.manager.name, 'manager', u.manager.pin, now);
  insUser.run('usr_priya', DEMO.tenants.fwd, u.accounts.name, 'accounts', u.accounts.pin, now);
  insUser.run('usr_ops', DEMO.tenants.fwd, u.operator.name, 'operator', u.operator.pin, now);
  insUser.run('usr_ravi', DEMO.tenants.other, u.otherAnalyst.name, 'analyst', u.otherAnalyst.pin, now);

  const insTariff = db.prepare(
    `INSERT OR IGNORE INTO tariffs
     (id, tenant_id, terminal_id, version, currency, terminal_tz, clock_trigger, free_days,
      include_trigger_day, include_end_day, exempt_weekends, exempt_closures,
      rate_tiers, closure_dates, effective_from, effective_to, closure_calendar_hash, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insTariff.run(
    DEMO.tariffs.inmaa1May, DEMO.tenants.fwd, 'INMAA1', '2026-05', 'INR', 'Asia/Kolkata',
    'discharge', 2, 1, 1, 0, 1,
    JSON.stringify([{ from_day: 1, to_day: null, rate_minor: 100000 }]),
    JSON.stringify([]), '2026-01-01', null, null, 'seed', now,
  );
  // A second, ambiguous tariff version for overlap tests (not pinned by the demo scene).
  insTariff.run(
    'trf_inmaa1_2025_11', DEMO.tenants.fwd, 'INMAA1', '2025-11', 'INR', 'Asia/Kolkata',
    'discharge', 2, 1, 1, 0, 1,
    JSON.stringify([{ from_day: 1, to_day: null, rate_minor: 90000 }]),
    JSON.stringify([]), '2025-11-01', '2026-04-30', null, 'seed', now,
  );

  const insPartner = db.prepare(
    `INSERT OR IGNORE INTO partners
     (id, tenant_id, name, endpoint, service_id, network, asset, verification, test_environment, callback_secret, capabilities, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insPartner.run(
    DEMO.partners.localDemo, DEMO.tenants.fwd, 'PED Demo Evidence Co-op (team-controlled fake merchant)',
    null, 'svc_gate_record', 'local-demo', 'INR', 'hmac_sha256', 'local-sandbox',
    'demo-callback-secret', JSON.stringify({ quote: true, execute: 'local_demo', auto_callback: true }),
    'configured', now,
  );
  insPartner.run(
    DEMO.partners.kite, DEMO.tenants.fwd, 'Terminal Gate Records Ltd (kite route, unverified)',
    'https://terminal-data.example.invalid/api', 'svc_gate_record', 'kite', 'INR', 'hmac_sha256',
    'none-configured', 'kite-callback-secret',
    JSON.stringify({ quote: true, execute: 'kite_session', auto_callback: false }),
    'configured', now,
  );
}

export function isSeeded(db: Db): boolean {
  return one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM tenants')?.n !== 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  seedDemo(db);
  console.log(`seeded demo dataset into ${cfg.dbPath}`);
}
