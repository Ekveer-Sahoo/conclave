# Conclave

An event-sourced multi-model council for reviewing, planning, and executing
coding work. A fixed panel of seats — each backed by a different model and
judging a different concern (architecture, correctness, spec fidelity,
security, testability, performance, simplicity) — deliberates through a
13-phase state machine, with disagreements resolved by arbitration and
progress gated by ratification votes. Every decision is an event; state is
always a projection over the log, never written directly.

## Packages

- `packages/core` — domain schemas (roles, seats, findings/verdicts, the
  `EventEnvelope` union) and shared types. No I/O.
- `packages/orchestrator` — the event store (`EventStore`, SQLite-backed,
  append-only) and the `SessionProjection` reducer (`projectSession`) that
  folds the log into current session state.

## Current capabilities

- Full event schema (`EventEnvelopeSchema`) covering all 20 event types the
  session lifecycle can emit — session/phase transitions, seat invocations,
  contentions, arbitration, ratification votes, worktrees, artifacts, and
  budget spend.
- `EventStore`: append (schema-validated, auto-incrementing `seq`), replay
  (per-session, ordered), `listSessions`, and persistence across process
  restarts via SQLite WAL.
- `projectSession`: pure reducer producing a `SessionProjection` from a
  replayed event list. Replaying the same log always yields the same
  projection — this is covered directly in tests.
- Test coverage for both the store (append/replay/persistence/schema
  rejection) and the projection (folds every event type).

## Not yet implemented

- **Phase transition engine** — a pure `transition(projection, signal)`
  function with guards for all 13 phases (INTAKE → PLAN → PLAN_AUDIT →
  PLAN_REFINE → DELIBERATE → RATIFY_PLAN → EXECUTE → WORK_AUDIT →
  WORK_REFINE → REMEDIATE → RE_AUDIT → RATIFY_WORK → REPORT). Advancement
  depends on aggregate state (quorum, ratification, open contentions, round
  caps, budget, artifacts) rather than the latest event alone, so this sits
  above the projection, not inside it.
- **Seat adapters** — pluggable model backends (`fake` for deterministic
  tests, `xenia` for live invocation) implementing a common "invoke seat,
  get verdict" interface.
- **Deliberation & contention detection** — fan out a phase's findings
  across seats, detect conflicting verdicts on the same target, open
  contentions.
- **Arbitration** — policy for resolving open contentions.
- **Ratification** — vote tallying and threshold checks that gate phase
  advancement.
- **Worktree execution** — EXECUTE phase creates isolated git worktrees,
  runs work, captures artifacts.
- **Budget enforcement** — cost accumulation against a session ceiling.
- **Session driver** — ties the above into a resumable `runSession(task)`
  loop; a session must be fully reconstructable from its event log alone.
- **CLI** — `conclave run <task>` entrypoint with human-readable output.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Design rule

Phase logic must be pure: it returns decisions/events, never writes to
SQLite directly. A coordinator validates and appends those events through
`EventStore`. This keeps the engine deterministic, replayable, and testable
without a database in the loop.
