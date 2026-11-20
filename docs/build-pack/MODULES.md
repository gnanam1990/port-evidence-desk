# Port Evidence Desk · module index

These are dependency-ordered work units. Once a contract is agreed, UI, adapter and test contributors may proceed on fixtures matching that contract and integrate against its real implementation before acceptance.

1. [M01 · Invoice and voyage intake](prompts/M01.md) — Parse bounded CSV and a canonical JSON form, normalize amounts as integer minor units, require voyage, terminal and invoice identity, and preserve file provenance.
2. [M02 · Tariff clock and day ledger](prompts/M02.md) — Model effective tariff versions, terminal-local dates, rate tiers, exception calendars and explicit start/end inclusion. Make each day independently inspectable.
3. [M03 · Evidence graph and uncertainty](prompts/M03.md) — Attach signed or authenticated source records to events; identify conflicts and bounded gaps and compute alternative valid charge outcomes.
4. [M04 · Quote and scoped acquisition](prompts/M04.md) — Capture quote, price asset, expiry, permitted seller and redistribution rights. Require an applicable case budget, an auditable comparison and a Kite-compatible payment route before dispatch.
5. [M05 · Partner reconciliation](prompts/M05.md) — Implement authenticated retrieval or callbacks with idempotency, provenance hashes, unknown-order handling and selective retry. Add manual conflict resolution and a reason trail.
6. [M06 · Analyst casebook and export](prompts/M06.md) — Build a keyboard-accessible invoice/day comparison and evidence panel. Export review-approved calculations and licensed attachments with a case manifest.
7. [M07 · Credit posting and portfolio reporting](prompts/M07.md) — Record referenced credits against invoice lines and expose disputed, submitted where manually evidenced, and credited amounts across active cases, with per-currency subtotals.
8. [M08 · End-to-end operator replay](prompts/M08.md) — Exercise import, governed data acquisition, late correction, exported artifacts and accounting through normal user surfaces; provide a licensed pilot-fixture intake path.
