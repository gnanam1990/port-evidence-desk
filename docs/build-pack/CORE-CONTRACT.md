# Port Evidence Desk · acceptance contract

### FR-01 — Invoice and voyage intake

Parse bounded CSV and a canonical JSON form, normalize amounts as integer minor units, require voyage, terminal and invoice identity, and preserve file provenance.

### INV-01 — Invoice and voyage intake

A duplicate file or invoice identifier cannot create a second charge line silently.

### FR-02 — Tariff clock and day ledger

Model effective tariff versions, terminal-local dates, rate tiers, exception calendars and explicit start/end inclusion. Make each day independently inspectable.

### INV-02 — Tariff clock and day ledger

An invoice calculation always names an immutable tariff version and currency.

### FR-03 — Evidence graph and uncertainty

Attach signed or authenticated source records to events; identify conflicts and bounded gaps and compute alternative valid charge outcomes.

### INV-03 — Evidence graph and uncertainty

Potential dispute and confirmed credit are different fields with separate provenance.

### FR-04 — Quote and scoped acquisition

Capture quote, price asset, expiry, permitted seller and redistribution rights. Require an applicable case budget, an auditable comparison and a Kite-compatible payment route before dispatch.

### INV-04 — Quote and scoped acquisition

A case limit in INR cannot be compared to token units without a specified valid conversion.

### FR-05 — Partner reconciliation

Implement authenticated retrieval or callbacks with idempotency, provenance hashes, unknown-order handling and selective retry. Add manual conflict resolution and a reason trail.

### INV-05 — Partner reconciliation

Correction creates a new source revision; original raw records remain traceable.

### FR-06 — Analyst casebook and export

Build a keyboard-accessible invoice/day comparison and evidence panel. Export review-approved calculations and licensed attachments with a case manifest.

### INV-06 — Analyst casebook and export

Any changed tariff, gate record or source revision invalidates the active approval.

### FR-07 — Credit posting and portfolio reporting

Record referenced credits against invoice lines and expose disputed, submitted where manually evidenced, and credited amounts across active cases, with per-currency subtotals.

### INV-07 — Credit posting and portfolio reporting

A package export cannot increase cash recovered; duplicate carrier credit references do not double-count.

### FR-08 — End-to-end operator replay

Exercise import, governed data acquisition, late correction, exported artifacts and accounting through normal user surfaces; provide a licensed pilot-fixture intake path.

### INV-08 — End-to-end operator replay

A gap or unavailable partner is visible to both analyst and operator after restart.

### NFR-01 — Replayable evidence

A reviewer can reproduce the outcome from the exact input revision, actor scope, persisted decision and redacted evidence reference after a process restart.
