# Decision record

- Date: 2026-11-20
- Owner: devin (implementation agent)
- Affected module: all (persistence baseline, M01 onward)
- Alternatives:
  1. PostgreSQL per TDD baseline — rejected: the sandbox cannot start a server (`initdb` fails on `shmget(...): Operation not permitted`, no running cluster at /tmp:5432, docker present but unverified and heavyweight for this run).
  2. better-sqlite3 — rejected: native build adds a compile dependency.
  3. `node:sqlite` (DatabaseSync) — chosen: zero external deps, synchronous transactions support the atomic domain-write+outbox pattern the TDD requires, WAL mode lets the web and worker processes share the file.
- Chosen behavior: SQLite via `node:sqlite`, versioned SQL migrations in `src/migrations/`, `PRAGMA foreign_keys=ON`, `busy_timeout=5000`. SQL kept standard where possible; tenant scoping, uniqueness and partial indexes preserve the Postgres-intended semantics.
- Dependency proof: `initdb -D pgdata` output `FATAL: could not create shared memory segment: Operation not permitted / shmget`.
- Affected tests: all integration tests run against real on-disk SQLite files under `var/test-tmp/`.
- Reopen conditions: a sandbox with working PostgreSQL (or a compose file supplied by the owner) — swap `src/db.ts` for a `pg` driver behind the same `tx/one/all` interface and re-run migrations 1:1.
