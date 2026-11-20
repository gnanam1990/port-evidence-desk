# Port Evidence Desk · Product requirements

## Product decision

Reconstruct one terminal's import demurrage invoice using a configurable, versioned tariff and authorized gate events. Deliver an explainable calculation and a dispute package that the forwarder can export. Detention after gate-out requires a separate equipment clock and tariff model.

**Buyer and commercial hypothesis.** Freight forwarders handling many detention or demurrage charges. Sell a per-container or per-case subscription. Start with one terminal and tariff.

**People and responsibilities.** A forwarder's invoice analyst opens a case, an operations manager controls the evidence budget and approves the dispute, a licensed data partner supplies terminal events, and an accounting reviewer records settlement against a carrier credit.

## Customer journey

Import the invoice and select its governing tariff. Inspect which trip events are proven, disputed or absent. See the possible charge range and the partner's quote for the missing event. Set a cap, authorize retrieval, review the normalized timeline and export a versioned claim. Accounts records a credit only when the carrier issues it.

## Acceptance scene

Example configured terminal tariff in INR uses local calendar dates, a discharge date of May 1 as free day one, May 2 as free day two, then INR 1,000/day including gate-out date. Carrier bills INR 3,000. Gate-out could be May 4 or 5, so expected charge is INR 2,000–3,000 and potential dispute INR 0–1,000. Under a manager-approved INR 200 evidence ceiling and an explicit policy permitting investigation of that range, a quote of INR 150 is eligible. An authorized May 4 record fixes the variance at INR 1,000. A later carrier credit of INR 700 records actual recovery of INR 700; without the credit recovery is zero. If the evidence quote is denominated in another asset, require a pinned conversion within its validity window or block authorization.

## Behaviors for the team

- **FR-01 · Invoice and voyage intake.** Parse bounded CSV and a canonical JSON form, normalize amounts as integer minor units, require voyage, terminal and invoice identity, and preserve file provenance.
- **FR-02 · Tariff clock and day ledger.** Model effective tariff versions, terminal-local dates, rate tiers, exception calendars and explicit start/end inclusion. Make each day independently inspectable.
- **FR-03 · Evidence graph and uncertainty.** Attach signed or authenticated source records to events; identify conflicts and bounded gaps and compute alternative valid charge outcomes.
- **FR-04 · Quote and scoped acquisition.** Capture quote, price asset, expiry, permitted seller and redistribution rights. Require an applicable case budget, an auditable comparison and a Kite-compatible payment route before dispatch.
- **FR-05 · Partner reconciliation.** Implement authenticated retrieval or callbacks with idempotency, provenance hashes, unknown-order handling and selective retry. Add manual conflict resolution and a reason trail.
- **FR-06 · Analyst casebook and export.** Build a keyboard-accessible invoice/day comparison and evidence panel. Export review-approved calculations and licensed attachments with a case manifest.
- **FR-07 · Credit posting and portfolio reporting.** Record referenced credits against invoice lines and expose disputed, submitted where manually evidenced, and credited amounts across active cases, with per-currency subtotals.
- **FR-08 · End-to-end operator replay.** Exercise import, governed data acquisition, late correction, exported artifacts and accounting through normal user surfaces; provide a licensed pilot-fixture intake path.

The [acceptance contract](CORE-CONTRACT.md) defines the fail/hold conditions for each requirement. Show the operator the responsible actor, decision reason, missing input and next possible action.

## Demand and release evidence

Secure permission from one terminal-data provider and a forwarder with anonymized historical invoices, applicable tariffs and known event corrections. Compare calculations with independently reviewed carrier statements. Confirm rights to attach records to a customer dispute. Use a customer-operated adapter for a demonstrable integration when the commercial connector remains pending.

Track completed cases over attempted cases, human exceptions, time to resolution and direct provider costs. Preserve the denominator and separate demonstration records from pilot records. Compare with the buyer's current manual workflow on the same cases. The adjacent Atlas project is [ShortPay](https://devpost.com/software/to-be-decided-g0ucje); customer willingness to pay requires pilot evidence.

## Larger team scope

- Versioned tariff calendars, free-time rules and charge-line reconciliation
- Evidence procurement per source, timestamps and provenance dispute handling
- Portfolio prioritization with evidence cost, currency and uncertain recoverability
- Case evidence assembly, deadline handling and actual recovery reconciliation

These are product surfaces for a substantial team backlog. Size independently deliverable changes from real integrations, acceptance cases and findings. Around 500 meaningful commits is a scope preference. Actual change count follows the implementation.
