# Port Evidence Desk · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** A forwarder's invoice analyst opens a case, an operations manager controls the evidence budget and approves the dispute, a licensed data partner supplies terminal events, and an accounting reviewer records settlement against a carrier credit.

## Domain schema

Case(id, tenant_id, container_ref, voyage_ref, invoice_id, terminal_id, currency); ChargeLine(id, case_id, service, billed_minor, period); Tariff(id, version, terminal_tz, effective_from, clock_trigger, free_days, day_basis, closure_calendar_hash, rate_tiers, currency); Event(id, case_id, type, local_time, offset, utc, supplier, record_id, source_digest, revision); Gap(id, case_id, required_event, uncertainty_minor); EvidenceOrder(id, gap_id, approved_quote, currency, rail, vendor_ref, status); Calculation(id, inputs_digest, tariff_version, day_breakdown, expected_minor, potential_variance_minor); Filing(id, calculation_id, manifest_sha); Credit(id, charge_line_id, reference, amount_minor, effective_on).

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /cases/import; PUT /cases/{id}/tariff; POST /cases/{id}/events; GET /cases/{id}/estimate; POST /gaps/{id}/quotes; POST /quotes/{id}/authorize; POST /partners/{id}/events for authenticated callbacks; POST /cases/{id}/packages; POST /cases/{id}/credits.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Keep original timestamps, explicit offsets and terminal timezone. Verify event matches terminal, container and voyage. Calculate chargeable calendar dates under the attached tariff and documented boundary conventions; configuration chooses weekends, closures and free days. Produce one explainable row per date and tier. If a required event has a bounded plausible range, recompute alternative boundaries and expose the minimum and maximum disputed amount. Unbounded events or ambiguous tariffs require human input. A quote is eligible only when capped, authorized and less than the analyst-approved recoverable-value bound in a common currency. Separate potential dispute, approved filing and received credit. Recompute when evidence changes and require reapproval of the changed package.

## State model

Open → tariff_confirmed → evidence_gap or computable → evidence_authorized → awaiting_partner → analyst_review → package_approved → exported. Case accounting can later become partially_credited or credited. Conflicting timestamps create conflict_review; pending partner settlement remains unknown. Export records delivery of a document, not external filing or reimbursement.

## Recovery

Deduplicate partner records by supplier, record ID and revision. Append contradictory events instead of overwriting. A late correction recomputes a new calculation revision and invalidates review of the old package; preserve the historical export. Reconcile a charged partner order with its original ID after restart. Failed commercial confirmation leaves the paid connector capability blocked.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
