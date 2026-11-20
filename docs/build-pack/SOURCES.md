# Port Evidence Desk · Reuse and evidence

The owner’s GitHub inventory and selected source files were reviewed on 20 November 2026. Each link below pins the reviewed revision. Inspect current target behavior, compatibility and license at intake. If private access is unavailable, implement the specified interface independently and record that choice. This pack contains no upstream source code or credentials.

### dockside-near

Pinned baseline `dcc900e4feb6a720f87a3fb508add815bd384b89` (public). Use inspection evidence and idempotency patterns. Freight tariff rules and access to terminal records are new work.

[evidence.rs](https://github.com/gnanam1990/dockside-near/blob/dcc900e4feb6a720f87a3fb508add815bd384b89/contract/crates/dockside-escrow-core/src/evidence.rs) · [idempotency.ts](https://github.com/gnanam1990/dockside-near/blob/dcc900e4feb6a720f87a3fb508add815bd384b89/packages/core/src/idempotency.ts)

### flowops

Pinned baseline `c0431c67b62d069ee300773fd2549c64d746667b` (public). Adapt settlement and reconciliation outcomes to purchased job inputs. Decide who absorbs a failed delivery and reconcile late outcomes.

[ascp_settlement.go](https://github.com/gnanam1990/flowops/blob/c0431c67b62d069ee300773fd2549c64d746667b/cmd/control-plane-api/ascp_settlement.go) · [reconciliation_outcomes.go](https://github.com/gnanam1990/flowops/blob/c0431c67b62d069ee300773fd2549c64d746667b/cmd/control-plane-api/reconciliation_outcomes.go)

## Project lineage

Hackathon Atlas surfaced [ShortPay](https://devpost.com/software/to-be-decided-g0ucje) as adjacent work. The user-approved project boundary is: Reconstruct one terminal's import demurrage invoice using a configurable, versioned tariff and authorized gate events. Deliver an explainable calculation and a dispute package that the forwarder can export. Detention after gate-out requires a separate equipment clock and tariff model.

## External dependency

Requires a willing data provider and permission to use gate records. Show disputed value separately from money actually recovered. Platform interfaces are documented in [provider notes](KITE-AND-PROVIDERS.md). Market demand, integration behavior, source data access and live payment authority require separate evidence.
