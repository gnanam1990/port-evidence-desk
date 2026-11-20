import path from 'node:path';

export interface AppConfig {
  dbPath: string;
  exportDir: string;
  port: number;
  /** Max request body bytes. Inbound CSV/JSON payloads are bounded. */
  maxBodyBytes: number;
  /** Max CSV data rows accepted in one import. */
  maxCsvRows: number;
  /** Hostname allowlist for outbound provider calls. Demo adapters never egress. */
  providerAllowlist: string[];
  workerPollMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const root = process.cwd();
  return {
    dbPath: env.PED_DB ?? path.join(root, 'var', 'ped.db'),
    exportDir: env.PED_EXPORT_DIR ?? path.join(root, 'exports'),
    port: Number(env.PORT ?? 4173),
    maxBodyBytes: Number(env.PED_MAX_BODY ?? 64 * 1024),
    maxCsvRows: Number(env.PED_MAX_CSV_ROWS ?? 200),
    providerAllowlist: (env.PED_PROVIDER_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    workerPollMs: Number(env.PED_WORKER_POLL_MS ?? 200),
  };
}
