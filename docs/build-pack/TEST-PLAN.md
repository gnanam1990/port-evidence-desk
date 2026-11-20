# Port Evidence Desk · Test plan

Every test begins NOT_RUN. [Registry](requirements.json) links each test to one module and its requirement. Run fast domain tests first, then real database/worker integration and normal browser entry points. External integration evidence states its environment and provider.

## Reference end-to-end acceptance

Example configured terminal tariff in INR uses local calendar dates, a discharge date of May 1 as free day one, May 2 as free day two, then INR 1,000/day including gate-out date. Carrier bills INR 3,000. Gate-out could be May 4 or 5, so expected charge is INR 2,000–3,000 and potential dispute INR 0–1,000. Under a manager-approved INR 200 evidence ceiling and an explicit policy permitting investigation of that range, a quote of INR 150 is eligible. An authorized May 4 record fixes the variance at INR 1,000. A later carrier credit of INR 700 records actual recovery of INR 700; without the credit recovery is zero. If the evidence quote is denominated in another asset, require a pinned conversion within its validity window or block authorization.

Run from a clean checkout. Capture the action through the UI or supported API, restart at an uncertain boundary, inspect the recovered record with a second authorized session and export the allowed outcome. Verify a different tenant cannot access it. Exercise the chosen provider against an authorized sandbox/test environment; a local boundary emulator is suitable for deterministic fault injection. Qualify each result by environment.

## Module tests

### T-001 — Invoice and voyage intake • expected behavior

Status: NOT_RUN

Import the INR 3,000 invoice twice and retrieve one case with one source digest.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-002 — Invoice and voyage intake • failure boundary

Status: NOT_RUN

The same invoice key with a changed amount opens a conflicting revision for review.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-003 — Tariff clock and day ledger • expected behavior

Status: NOT_RUN

May 4 gate-out creates exactly two chargeable dates and an INR 2,000 expected charge.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-004 — Tariff clock and day ledger • failure boundary

Status: NOT_RUN

A missing governing tariff or undefined overlap between versions returns unpriced, never a zero charge.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-005 — Evidence graph and uncertainty • expected behavior

Status: NOT_RUN

A May 4–5 range yields INR 0–1,000 potential dispute and no received credit.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-006 — Evidence graph and uncertainty • failure boundary

Status: NOT_RUN

A gate-out record for the same container on a different voyage is quarantined.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-007 — Quote and scoped acquisition • expected behavior

Status: NOT_RUN

A comparable INR 150 quote under the INR 200 ceiling emits one authorized order.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-008 — Quote and scoped acquisition • failure boundary

Status: NOT_RUN

An expired conversion or INR 201 quote cannot dispatch, including after duplicate clicks.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-009 — Partner reconciliation • expected behavior

Status: NOT_RUN

Two identical callbacks converge to one May 4 event and one paid order.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-010 — Partner reconciliation • failure boundary

Status: NOT_RUN

Conflicting authenticated gate times trigger review rather than automatically selecting the cheapest charge.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-011 — Analyst casebook and export • expected behavior

Status: NOT_RUN

Exported manifest reproduces the INR 1,000 variance from its pinned inputs.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-012 — Analyst casebook and export • failure boundary

Status: NOT_RUN

Replacing May 4 with a corrected May 5 event prevents re-export under the previous approval.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-013 — Credit posting and portfolio reporting • expected behavior

Status: NOT_RUN

Posting an INR 700 carrier credit twice leaves total recovered at INR 700.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-014 — Credit posting and portfolio reporting • failure boundary

Status: NOT_RUN

A credit with incompatible currency or tenant cannot be attached to the case.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-015 — End-to-end operator replay • expected behavior

Status: NOT_RUN

Restart while the original partner order is pending; late delivery is linked without a second charge.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.

### T-016 — End-to-end operator replay • failure boundary

Status: NOT_RUN

With no accessible licensed provider, the real-partner result stays blocked and the export cannot label synthetic records as terminal evidence.

Record the initial persisted state, actor, observable result and final persisted state. Attach the test command and test report to the implementation handoff.
