-- Port Evidence Desk schema v1. All money is integer minor units with an explicit asset code.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('analyst', 'manager', 'accounts', 'operator')),
  pin TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE partners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  endpoint TEXT,
  service_id TEXT,
  network TEXT,
  asset TEXT,
  verification TEXT NOT NULL DEFAULT 'hmac_sha256',
  test_environment TEXT,
  callback_secret TEXT NOT NULL,
  capabilities TEXT NOT NULL,             -- json: quote/execute/auto_callback/rail
  status TEXT NOT NULL DEFAULT 'configured', -- configured | unavailable | blocked
  created_at TEXT NOT NULL
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  container_ref TEXT NOT NULL,
  voyage_ref TEXT NOT NULL,
  invoice_ref TEXT NOT NULL,
  terminal_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  source_class TEXT NOT NULL DEFAULT 'customer',  -- customer | pilot_fixture | demo
  tariff_id TEXT,
  tariff_version TEXT,
  ceiling_minor INTEGER,
  ceiling_asset TEXT,
  ceiling_policy_ref TEXT,
  ceiling_set_by TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, invoice_ref)
);

CREATE TABLE invoice_documents (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  filename TEXT,
  format TEXT NOT NULL,
  received_by TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',  -- accepted | conflict | superseded
  provenance TEXT NOT NULL DEFAULT 'customer', -- customer | pilot_fixture | demo
  parsed_json TEXT NOT NULL,
  raw TEXT NOT NULL,
  UNIQUE (case_id, revision),
  UNIQUE (case_id, source_digest)
);

CREATE TABLE charge_lines (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  service TEXT NOT NULL,
  billed_minor INTEGER NOT NULL,
  period_start TEXT,
  period_end TEXT,
  source TEXT NOT NULL DEFAULT 'invoice'
);
CREATE INDEX charge_lines_case ON charge_lines(case_id);

CREATE TABLE tariffs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  terminal_id TEXT NOT NULL,
  version TEXT NOT NULL,
  currency TEXT NOT NULL,
  terminal_tz TEXT NOT NULL,
  clock_trigger TEXT NOT NULL,            -- discharge | gate_in
  free_days INTEGER NOT NULL,
  include_trigger_day INTEGER NOT NULL DEFAULT 1,
  include_end_day INTEGER NOT NULL DEFAULT 1,
  exempt_weekends INTEGER NOT NULL DEFAULT 0,
  exempt_closures INTEGER NOT NULL DEFAULT 1,
  rate_tiers TEXT NOT NULL,               -- json [{from_day, to_day|null, rate_minor}]
  closure_dates TEXT NOT NULL,            -- json ["YYYY-MM-DD"]
  effective_from TEXT NOT NULL,
  effective_to TEXT,                      -- null = open ended
  closure_calendar_hash TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, terminal_id, version)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  type TEXT NOT NULL,                     -- discharge | gate_out | gate_in | empty_return
  local_date TEXT NOT NULL,
  local_time TEXT,
  utc_offset TEXT NOT NULL,
  utc_instant TEXT NOT NULL,
  supplier TEXT NOT NULL,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  source_digest TEXT NOT NULL,
  provenance TEXT NOT NULL,               -- partner_signed | partner_authenticated | analyst_manual | pilot_fixture | synthetic
  status TEXT NOT NULL DEFAULT 'proven',  -- proven | disputed | quarantined | superseded | pending
  detail TEXT,                            -- json extra (e.g. quarantine reason, raw record ref)
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, supplier, record_id, revision)
);
CREATE INDEX events_case ON events(case_id, type, status);

CREATE TABLE gaps (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  required_event TEXT NOT NULL,
  plausible_from TEXT,
  plausible_to TEXT,
  bound_reason TEXT,
  uncertainty_min_minor INTEGER,
  uncertainty_max_minor INTEGER,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'open',    -- open | unbounded | ordered | resolved | blocked
  created_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  UNIQUE (case_id, required_event)
);

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  gap_id TEXT NOT NULL REFERENCES gaps(id),
  partner_id TEXT NOT NULL REFERENCES partners(id),
  service_id TEXT,
  endpoint TEXT,
  network TEXT,
  test_environment TEXT,
  price_minor INTEGER NOT NULL,
  asset TEXT NOT NULL,
  conversion_json TEXT,                   -- {rate_num, rate_den, to_asset, pinned_at, valid_until, source}
  expires_at TEXT NOT NULL,
  redistribution_rights TEXT NOT NULL,    -- attach_to_dispute | reference_only | internal_only
  status TEXT NOT NULL DEFAULT 'open',    -- open | consumed | expired | rejected
  captured_by TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  raw TEXT
);

CREATE TABLE evidence_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id),
  gap_id TEXT NOT NULL REFERENCES gaps(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  amount_minor INTEGER NOT NULL,
  asset TEXT NOT NULL,
  ceiling_minor INTEGER NOT NULL,
  ceiling_asset TEXT NOT NULL,
  converted_ceiling_minor INTEGER,        -- ceiling expressed in quote asset when conversion was pinned
  conversion_ref TEXT,
  rail TEXT NOT NULL,                     -- local_demo | kite_session
  vendor_ref TEXT NOT NULL UNIQUE,        -- order id sent to the provider
  status TEXT NOT NULL,                   -- authorized | dispatch_pending | awaiting_delivery | delivered | failed | blocked_external | pending_reconciliation | cancelled
  settlement_scope TEXT NOT NULL,         -- local_demo | external
  paid INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  authorized_by TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  dispatched_at TEXT,
  delivered_at TEXT
);
-- Only one live order per gap.
CREATE UNIQUE INDEX evidence_orders_live_gap ON evidence_orders(gap_id)
  WHERE status NOT IN ('cancelled', 'blocked_external', 'failed');

CREATE TABLE calculations (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  revision INTEGER NOT NULL,
  inputs_digest TEXT NOT NULL,
  tariff_id TEXT,
  tariff_version TEXT,
  currency TEXT,
  status TEXT NOT NULL,                   -- priced | unpriced | missing_events | conflict
  billed_minor INTEGER NOT NULL,
  expected_minor INTEGER,
  expected_min_minor INTEGER,
  expected_max_minor INTEGER,
  variance_min_minor INTEGER,
  variance_max_minor INTEGER,
  day_breakdown TEXT NOT NULL,            -- json scenarios with per-day rows
  missing TEXT,                           -- json missing inputs
  computed_at TEXT NOT NULL,
  computed_by TEXT,
  UNIQUE (case_id, revision)
);
CREATE INDEX calculations_case ON calculations(case_id, revision);

CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  calculation_id TEXT NOT NULL REFERENCES calculations(id),
  inputs_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | approved | exported | stale
  approved_by TEXT,
  approved_at TEXT,
  manifest_sha TEXT,
  export_dir TEXT,
  exported_at TEXT,
  exported_by TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE credits (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id),
  charge_line_id TEXT,
  reference TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  effective_on TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'carrier_credit',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, reference)
);
CREATE INDEX credits_case ON credits(case_id);

CREATE TABLE partner_callbacks (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  order_ref TEXT,
  record_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  signature_ok INTEGER NOT NULL,
  outcome TEXT NOT NULL,                  -- accepted | duplicate | quarantined | parked_unknown_order | conflict | superseded | rejected
  body_digest TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (partner_id, record_id, revision)
);

CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  kind TEXT NOT NULL,                     -- invoice_revision | event_time | evidence
  status TEXT NOT NULL DEFAULT 'open',    -- open | resolved
  detail TEXT NOT NULL,                   -- json
  created_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_reason TEXT,
  winner_event_id TEXT
);
CREATE INDEX conflicts_case ON conflicts(case_id, status);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  idem_key TEXT,
  actor TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  status TEXT NOT NULL,                   -- running | done | failed
  result_ref TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, kind, idem_key)
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  op_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | done | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT
);
CREATE INDEX outbox_pending ON outbox(status, next_attempt_at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  op_id TEXT,
  actor TEXT,
  actor_role TEXT,
  decision_code TEXT NOT NULL,
  detail TEXT,
  external_ref TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_tenant ON audit_log(tenant_id, created_at);
