# Port Evidence Desk

Reconstructs a terminal's import **demurrage** invoice against a versioned,
terminal-local tariff and authorized gate evidence, then packages a governed
dispute claim. Built for freight forwarders reviewing carrier
detention/demurrage bills. Detention after gate-out is out of scope — that
needs a separate equipment clock model.

Stack: Node.js 22+ (native TypeScript strip-types, no transpiler), `node:http`,
`node:sqlite` (migrations + outbox), `node:test`. Zero runtime dependencies;
`typescript` is the only dev dependency. Server-rendered UI works with no
client JavaScript.

## Run

```sh
npm ci            # installs the typescript dev dependency only
npm run dev       # serves http://localhost:4173 (env: PORT, PED_DB, PED_EXPORT_DIR)
npm run worker    # optional separate outbox worker (server embeds one already)
```

Demo sign-ins (seeded): `aisha`/analyst, `mohan`/manager, `priya`/accounts,
`ops`/operator — pins are `<role>-demo-pin`. Browser UI at `/`; the same URLs
serve JSON to API clients via content negotiation
(`Accept: text/html` → HTML, otherwise JSON; `Authorization: Bearer <token>`).

## Verify

```sh
npm test          # 25 tests across M01–M08 (T-001..T-016 acceptance cases)
npm run typecheck # tsc --noEmit
npm run pack:check# validates the build pack is intact
```

## Operator flow

1. **Import** a JSON or bounded-CSV invoice (`POST /cases/import`,
   `POST /cases/import-fixture` for labeled pilot fixtures).
2. **Pin** a versioned tariff (`PUT /cases/:id/tariff`); post events
   (`POST /cases/:id/events`) and bounded gaps (`POST /cases/:id/gaps`) —
   the day ledger and min/max scenarios recompute automatically.
3. **Budget** (`POST /cases/:id/budget`, manager) then capture a quote
   (`POST /gaps/:id/quotes`) and authorize (`POST /quotes/:id/authorize`,
   manager). Cross-asset quotes need a pinned conversion inside its validity
   window or authorization fails closed.
4. Partner records arrive as **HMAC-signed callbacks**
   (`POST /partners/:id/events`); duplicates converge, contradictory dates
   open a review conflict, unknown orders park for reconciliation.
5. **Package → approve → export** (`POST /cases/:id/packages`,
   `POST /packages/:id/approve`, `POST /packages/:id/export`) writes
   `manifest.json`, `manifest.sha256`, `day-ledger.csv`, `claim.md`. Any input
   change marks the package `stale` and blocks re-export.
6. **Credits** (`POST /cases/:id/credits`, accounts) dedupe by carrier
   reference and reject currency/tenant mismatches. `GET /portfolio` reports
   disputed / submitted / credited separately per currency.

Operations ledger at `/ops` (HTML) or `GET /ops/status` (JSON): pending/failed
outbox rows, orders needing attention, parked callbacks, provider capability.

## Evidence rails and external gates

- `local_demo` — team-controlled fake merchant; `settlement_scope:
  local_demo`. Never a live payment.
- `kite_session` — paid route, deliberately **fail-closed**: without owner
  authority no live dispatch exists, so orders end `blocked_external` with
  `paid = 0`. Nothing claims Kite L1 settlement.
- Real terminal-data provider: none licensed in this run; pilot fixtures are
  labeled `pilot_fixture` and kept distinct from `customer`/`demo` sources.

Decisions live in `docs/decisions/`; module/test status and the missing-proof
ledger live in `build-progress/port-evidence-desk/`.
