# Port Evidence Desk · Threat model

Enforce tenant-level access on commercial invoices and evidence. Validate external record signature or a documented authenticated retrieval path, bind callback to order and voyage, reject replay and stale revisions, and redact commercial identifiers in exported examples. Contract rates and licensed gate records may restrict redistribution; export licensed excerpts or references only.

The web client, uploaded records and provider payloads are untrusted. Enforce organization, ownership and action-specific authorization at read and write boundaries. Test guessed IDs, stale approvals and access to evidence after membership revocation. Bound extraction payload sizes, validate data formats, redact secret-bearing query strings and keep private data out of public endpoints. Network clients restrict target schemes and destinations to configured providers. Keep customer data, tokens and payment details out of prompts and handoff logs.

Bind an operation to the actor, payload digest, amount limit, provider and expiry where applicable. Audit original and corrected decisions with actor and reason. Include redacted reproduction steps for a failed or unknown result. Align the retention policy with data rights agreed in the pilot.
