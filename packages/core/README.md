# @conclave/core

Domain schemas and shared types for Conclave: roles, seats, findings/verdicts,
and the `EventEnvelope` union that drives the session event log. Pure types
and Zod schemas — no I/O, no side effects.

This package is consumed by `@conclave/orchestrator` and is not intended to be
used standalone.

## Contents

- `EventEnvelopeSchema` and the individual event schemas that make up a
  Conclave session's append-only log.
- Role, seat, finding, and verdict types shared between the orchestrator's
  event store, session projection, and seat adapters.

## Development

```bash
pnpm install
pnpm --filter @conclave/core build
pnpm --filter @conclave/core typecheck
```

See [`packages/orchestrator/README.md`](../orchestrator/README.md) for the
operator-facing guide to running Conclave itself.
