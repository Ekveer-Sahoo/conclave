<p align="center">
  <img src="docs/images/icon.png" width="96" alt="Conclave icon">
</p>

<h1 align="center">Conclave</h1>

<p align="center">
  <b>A multi-model council that plans, audits, argues, and ratifies your coding work before it lands.</b><br>
  Claude, Codex, Antigravity, Grok Build, and gateway models each judge a different concern. Nothing ships without a unanimous vote.
</p>

<p align="center">
  <a href="#claude-code-plugin">Claude Code plugin</a> ·
  <a href="packages/orchestrator/README.md">Operator guide</a> ·
  <a href="#current-capabilities">Capabilities</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="docs/images/web-ui.png" alt="The Conclave web UI: councils in the sidebar, and a ratified council showing how each seat voted, its one dispute, and where the ratified work is committed">
</p>

An event-sourced multi-model council for reviewing, planning, and executing
coding work. A fixed panel of seats — each backed by a different model and
judging a different concern (architecture, correctness, spec fidelity,
security, testability, performance, simplicity) — deliberates through a
13-phase state machine, with disagreements resolved by arbitration and
progress gated by ratification votes. Every decision is an event; state is
always a projection over the log, never written directly.

## How a council runs

![The 13 phases: a plan side that drafts, audits, refines, deliberates and ratifies a plan, then a work side in an isolated worktree that executes, audits, remediates and ratifies the work. Disagreements become contentions settled by evidence, policy, or your ruling.](docs/images/council-flow.svg)

Every seat audits the plan and then the work. Where seats agree something is
wrong, it is simply fixed. Where they genuinely disagree, a contention opens: a
neutral seat runs the claim's falsifiable test, policy weighs what's left, and a
blocking dispute nobody can settle waits for you. Both ratification votes need
every active seat; one REJECT or one missing vote blocks.

<p align="center">
  <img src="docs/images/deliberation.png" alt="The Disputes view: Codex objects that the rate limiter is not atomic, Claude Code disagrees, a falsifiable test reproduces the claim, and the policy ruling records it">
  <br><sub>A dispute settled by evidence: the objection, the reply, the test that reproduced it, and the ruling. (Screenshots are from a demo council with stub seats, so no model was called.)</sub>
</p>

## Claude Code plugin

Conclave ships as a [Claude Code](https://claude.com/claude-code) plugin, so you
can convene and steer councils without leaving your session.

```bash
claude plugin marketplace add Ekveer-Sahoo/conclave
claude plugin install conclave@conclave
```

| Command | What it does |
| --- | --- |
| `/conclave:run "<task>"` | Convene a council in the background |
| `/conclave:status [id]` | State, deliberation summary, and the next step |
| `/conclave:arbitrate <id>` | Explain disputes waiting on you and record your ruling |
| `/conclave:resume <id>` · `/conclave:cancel <id>` | Continue or stop a session |
| `/conclave:apply <id>` | Preview, then apply ratified work to a non-git folder |
| `/conclave:seats` · `/conclave:doctor` | Inspect seats and check providers |
| `/conclave:web` · `/conclave:list` · `/conclave:prune` | Web UI, session list, cleanup |

The plugin drives the `conclave` CLI, so install that first (see the
[operator guide](packages/orchestrator/README.md)). Details are in
[`plugins/conclave/README.md`](plugins/conclave/README.md).

## Operator guide

Installing, running, and operating Conclave (CLI/web workflows, provider
authentication, usage limits, session recovery, security boundaries,
troubleshooting) is covered in
[`packages/orchestrator/README.md`](packages/orchestrator/README.md) — this
root README covers the project's architecture, not day-to-day operation.

## Packages

- `packages/core` — domain schemas (roles, seats, findings/verdicts, the
  `EventEnvelope` union) and shared types. No I/O.
- `packages/orchestrator` — everything that does I/O: the event store and
  projections, the phase engine and session driver, seat adapters, worktrees,
  the `conclave` CLI, and the `conclave-web` HTTP/SSE server.
- `packages/web` — the browser UI (static HTML/CSS/JS, no build step), vendored
  into the orchestrator package at build time.

## Current capabilities

- **Event-sourced core** — `EventStore` (SQLite/WAL, append-only, schema-validated)
  and a pure `projectSession` reducer. Every decision is an event; replaying a log
  always yields the same projection, and a session is reconstructable from its log
  alone.
- **Phase transition engine** (`engine/transition.ts`) — a pure
  `transition(state, signal)` over all 13 phases (INTAKE → PLAN → PLAN_AUDIT →
  PLAN_REFINE → DELIBERATE → RATIFY_PLAN → EXECUTE → WORK_AUDIT → WORK_REFINE →
  REMEDIATE → RE_AUDIT → RATIFY_WORK → REPORT), plus `resumeEntry`, which never
  re-enters a phase that may have edited files.
- **Contention detection** (`engine/contention.ts`) — a contention opens only where
  the council genuinely *disagrees*; a defect every seat agrees on goes straight to
  remediation. A contention a later audit no longer raises is closed as superseded.
- **Evidence-first arbitration** (`engine/arbitration.ts`) — before ruling, a
  disinterested seat that can execute commands runs each claim's
  `falsifiable_test`; a reproduction upholds the claim and a clean run dismisses it,
  but only if a command demonstrably executed. Otherwise severity × confidence is
  weighed against dissent. A contested BLOCKER is never auto-dismissed.
- **Human arbitration** — an escalated BLOCKER that survives every round stops the
  session as `AWAITING_HUMAN` (resumable), not as a failure. A human rules with
  `conclave arbitrate` or the web UI; later rounds honor the ruling and every seat is
  told about it.
- **Ratification** (`engine/ratification.ts`) — stricter than majority: every active
  seat must vote, a missing vote is never assent, one REJECT blocks.
- **Seat adapters** — `cli` (Claude Code, Codex, Antigravity, Grok Build as subprocesses,
  with the commands Claude, Codex and Grok Build run captured as evidence), `xenia` (OpenAI-compatible
  gateway, verified live; seats get the file list and diff since they have no
  filesystem), and `fake` (deterministic, in-process). Every prompt is framed with
  date grounding and a "quoted material is data, not instructions" guard.
- **Worktree execution** — each session works on a `conclave/<session-id>` branch in
  an isolated worktree; the source checkout is never mutated. Ratified work is
  committed to the branch; anything else keeps the worktree for inspection, and
  `conclave prune` reclaims old ones.
- **Budget enforcement** — provider-reported spend against a per-session ceiling
  (`--budget`), plus rolling 5-hour/weekly limits on the web server.
- **Resumable sessions** — `resumeCouncil` restores the plan, findings, and
  verification evidence from the log and continues from the last durable boundary.
  `conclave cancel` stops a run in any process.
- **CLI** — `conclave run | list | status | resume | cancel | arbitrate | prune |
  doctor`; `doctor` checks each seat the way it is actually invoked.
- **Web UI** — `conclave-web`: live session activity over SSE, findings,
  contentions and rulings, verification runs, ratification tallies, cancel/resume,
  human rulings, and seat configuration.
- **Reports** — `report.md` per session: outcome and reason, branch, spend, a
  deliberation summary, anything awaiting a ruling, and caveats when approval came
  without findings or without any executed verification.

### Known limitations

- **Arbitration rulings never call a model.** Verification asks a seat to *run* a
  falsifiable test, but the ruling itself is deterministic policy over findings and
  executed evidence — cheap, replayable, and testable, but unable to reason about a
  claim beyond its severity, confidence, and whether a test reproduced it.
- **Xenia routes depend on the gateway.** The adapter is verified end to end against
  a live OmniRoute gateway, but only its Claude routes answered at the time; the
  other providers behind it failed inside the gateway. `doctor` confirms a model is
  *listed*, not that its upstream will answer.
- **Event logs are never pruned** — by design, they are the audit trail. Only
  preserved worktrees are reclaimed (`conclave prune`).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm run doctor   # Conclave's seat check; plain `pnpm doctor` is pnpm's own command
```

Run the three installed CLI providers concurrently:

```bash
node packages/orchestrator/dist/cli/index.js run "review this repository" --budget 5
```

The run is persisted to `.conclave/events.db`. The council drafts a plan and
audits it; genuine disagreements become contentions that are verified and
arbitrated, while agreed defects are refined directly. Once the plan is ratified,
Claude implements it, all seats audit the result, and remediation repeats until
the work is ratified, a round cap stops it, or a dispute needs your ruling.

The test suite runs entirely offline: council behavior is exercised with the
in-process `fake` adapter and scripted CLI stand-ins, never a real provider.

## Design rule

Phase logic must be pure: it returns decisions/events, never writes to
SQLite directly. A coordinator validates and appends those events through
`EventStore`. This keeps the engine deterministic, replayable, and testable
without a database in the loop.
