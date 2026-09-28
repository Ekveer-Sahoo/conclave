# Changelog

All notable changes to Conclave are documented in this file.

## [0.1.0] - 2026-09-28

Initial release. Conclave is an event-sourced multi-model council for
reviewing, planning, and executing coding work: a panel of seats — each backed
by a different provider (Claude, Codex, and Antigravity CLIs, or models behind
an OpenAI-compatible gateway) and judging a different concern — deliberates
through a 13-phase state machine, with disagreements verified and arbitrated
and progress gated by ratification votes.

### Added

- **Event-sourced core**: append-only `EventStore` (SQLite/WAL-backed) and a
  pure `projectSession` reducer that folds the event log into current session
  state. Replaying the same log always yields the same projection.
- **Phase transition engine**: guarded advancement through all 13 phases
  (INTAKE → PLAN → PLAN_AUDIT → PLAN_REFINE → DELIBERATE → RATIFY_PLAN →
  EXECUTE → WORK_AUDIT → WORK_REFINE → REMEDIATE → RE_AUDIT → RATIFY_WORK →
  REPORT), gated by quorum, ratification, open contentions, round caps, and
  budget.
- **Deliberation and contention detection**: contentions open only where the
  council genuinely *disagrees* about a target — a material defect every active
  seat agrees on routes straight to remediation. Contention ids are derived from
  the target, so the same dispute re-detected in a later round reopens the same
  record; one that later audits no longer raise is closed as `SUPERSEDED`.
- **Falsifiable-test verification**: before arbitrating a contention, a seat
  with no stake in it that can execute commands (Claude, then Codex) runs each
  claim's `falsifiable_test` without editing anything. The result is recorded as
  a `VerificationRun` — reproduced, refuted, or inconclusive — and only counts as
  evidence when a command demonstrably executed. At most three per round.
- **Arbitration policy**: deterministic and evidence-first. Executed evidence
  settles a claim outright; otherwise severity × confidence is weighed against
  dissent, and only disinterested seats are recorded as arbiters. A contested
  BLOCKER is never auto-dismissed — an inconclusive ruling escalates to
  `HUMAN_ARBITRATION` and keeps blocking approval.
- **Human arbitration**: `conclave arbitrate <id> <contention> uphold|dismiss
  --reason …` and `POST /api/sessions/:id/contentions/:cid/ruling` settle an
  escalated contention (`ArbitrationRuled` now carries `source: policy|human`).
  Later rounds honor the ruling instead of re-arbitrating, and every seat prompt
  restates it. A session whose rounds run out with an escalation outstanding stops
  as `AWAITING_HUMAN` and resumes once every escalation has a ruling.
- **Session outcomes**: a new `SessionConcluded` event records `APPROVED`,
  `NOT_APPROVED`, or `AWAITING_HUMAN` with its reason, and projections expose
  `outcome` and a single `state` (`running`, `approved`, `not_approved`,
  `awaiting_human`, `cancelled`, `errored`).
- **Ratification**: formal vote tallying gating phase advancement (default
  quorum: `min(2, configured seats)`), deliberately stricter than a majority —
  every active seat must vote, a missing vote is never counted as assent, one
  REJECT blocks, `APPROVE_WITH_CHANGES` ratifies only when nothing is still
  open, and any open BLOCKER/MAJOR contention blocks outright.
- **Seat adapters**: `cli` (Claude Code, Codex, Antigravity via their native
  JSON/schema interfaces, with Claude's stream-json tool calls and Codex's
  `command_execution` items captured as verification evidence), `fake`
  (deterministic, in-process), and `xenia` (OpenAI-compatible gateway, with
  optional `CONCLAVE_XENIA_API_KEY` bearer auth and gateway cost headers).
  `seats/index.ts` dispatches on `seat.adapter`, so the phase machine never
  learns what backs a seat.
- **Repository context for filesystem-less seats**: Xenia seats are sent the
  repository's file list, and on the work side the full diff against the base
  commit, since they cannot read files themselves.
- **Prompt framing**: every seat prompt carries date grounding (so a seat does
  not call a model or library it doesn't recognize "fictional" and file a false
  BLOCKER) and states that quoted plans, diffs, files, other seats' reasoning,
  and command output are material to evaluate, not instructions.
- **Worktree execution**: every session runs in an isolated git worktree on a
  `conclave/<session-id>` branch. Ratified work is committed to the branch and
  the worktree removed; otherwise the worktree is preserved for inspection.
- **Retention**: `conclave prune --older-than <days> [--dry-run]` removes
  worktrees kept by old, inactive sessions (and their session branch when it
  holds no commit of its own), recording a `WorktreeRemoved` event. It never
  touches a running session or a ratified branch; event logs are kept.
- **Budget enforcement**: cost accumulation against a per-session ceiling
  (default $20, `--budget` on the CLI) and rolling usage limits
  (`CONCLAVE_LIMIT_5H_USD`, `CONCLAVE_LIMIT_WEEKLY_USD`; defaults $10 / $50),
  enforced on `POST /api/chat` with HTTP 429 on breach.
- **Resumable sessions**: a session is fully reconstructable from its event
  log. Resume restores the current plan, all findings, and verification evidence
  from the log, never re-runs a phase that may have edited files, and detects
  orphaned sessions via per-session PID lock files.
- **Out-of-process cancellation**: `conclave cancel <id>` (and `POST
  /api/sessions/:id/cancel`) stops a session running in any process — a CLI run
  in another terminal or the web server — via a cancel request the running
  driver polls for. The cancellation reason is recorded.
- **CLI**: `conclave run | list | status | resume | cancel | arbitrate | prune
  | doctor`. CLI runs register in the session registry, so `--db` is optional
  for session commands and the web UI lists CLI sessions too.
- **Per-seat CLI options**: `cliExtraArgs` (e.g. codex's `-c
  model_provider=openai`) lets a Conclave seat bypass a gateway or override a
  provider setting without editing that CLI's global configuration.
- **Adapter-aware `doctor`**: CLI seats get the existing login probe, run with
  the seat's own `cliModel` and `cliExtraArgs` so it checks what a run uses; Xenia
  seats are checked against the gateway's `/v1/models` without spending tokens
  (with close-match suggestions); fake seats always pass. An invalid seat
  configuration file fails `doctor` instead of silently running the defaults.
- **Web app** (`conclave-web`): live session activity over SSE; findings,
  contentions and their threads, arbitration rulings, verification runs, and
  ratification tallies; cancel, resume, and human-ruling controls; seats
  rendered from configuration for any adapter; durable session history.
- **Reports**: `report.md` per session with outcome and reason, branch or
  preserved worktree, spend, a deliberation summary, contentions awaiting a
  ruling (with the exact command to settle them), and caveats when approval came
  with no findings or no executed verification.
- **HTTP server hardening**: request-size caps, path-traversal-safe static
  asset serving, and redaction of AWS keys/PEM blocks/API tokens/absolute
  paths from browser-facing text — including session details, which are sent as
  a sanitized view rather than the raw projection.
- **Session registry**: durable cross-repository session index with
  corruption quarantine (`registry.db.corrupt-<timestamp>`).
- **Graceful shutdown**: in-flight sessions are given a chance to reach a
  safe checkpoint before the server exits.
- **Packaging**: `dist/` and vendored web assets are built via a `prepack`
  lifecycle script so `npm pack`/`pnpm pack` from a clean checkout always
  produces a complete tarball; bin entry points (`conclave`, `conclave-web`)
  are chmod +x at build time.
- **Operator documentation** (`packages/orchestrator/README.md`).

### Fixed

- Resuming a session restarted the council with an **empty plan**: a resumed
  PLAN_AUDIT audited nothing and a resumed EXECUTE implemented nothing, and all
  prior findings and verification evidence were forgotten. The plan is now part
  of the projection and restored, along with findings and evidence.
- A council that **declined** a plan or the work was recorded as
  `SessionErrored`, indistinguishable from a crash. It is now a
  `SessionConcluded` outcome.
- The web UI **polled seat health every 15 seconds**, and each CLI health probe
  is a real model call — hundreds of billed calls per hour with the page open.
  Health is now cached server-side (`CONCLAVE_AUTH_STATUS_TTL_MS`, default
  10 minutes) and re-probed only on request.
- **Rolling spend limits could silently stop being enforced**: one
  `BudgetSpent` without provider usage made the window total `NaN`, and
  `NaN >= limit` is false. Missing usage now counts as zero.
- `GET /api/sessions/:id` returned the **raw projection**, including absolute
  repository, worktree, and artifact paths, contradicting the documented
  browser redaction boundary.
- The first run in a repository created an untracked `.conclave/`, and **every
  later run was refused** as a dirty checkout unless the user gitignored it.
- An escalated contention that later rounds resolved stayed in
  `HUMAN_ARBITRATION` forever; it is now closed as `SUPERSEDED`. A re-detected
  contention now reopens (`OPEN`) instead of keeping its previous ruling.
- Evidence semantics: every allowlisted command a finding-scoped seat ran was
  recorded as a `VerificationRun` with PASS mapped to "claim reproduced", so a
  passing `git status` could uphold a claim. `VerificationRun` is now one
  judged result per verification.
- An audit round in which every seat failed carried on with zero seats; the
  quorum is now checked after every audit, not only at ratification.
- `conclave run` now resolves the user's seat configuration
  (`CONCLAVE_SEAT_CONFIG_PATH`) the same way `doctor` and the web server do,
  instead of always running the hardcoded `DEFAULT_CLI_SEATS`.
- Budget exhaustion is routed through the phase graph as a terminal council
  outcome rather than surfacing as an unhandled session crash.
- `conclave doctor` resolves the user's actual seat configuration, and only a
  failed or missing **required** (`enabled: true`) seat causes a nonzero exit.
- `BudgetSpent.latencyMs` is now the measured call latency instead of always 0.
- Message pages (`GET /api/sessions/:id/messages` and the SSE backlog) counted
  scanned events rather than messages, so a long run of non-chat events returned
  an empty page mid-stream that clients read as the end. The filter is now in SQL.
- A session advanced by another process — a `conclave run` in a terminal, or a
  ruling from the CLI — never reached a browser watching it live; the server now
  tails the log for every watched session.
- `POST /api/chat` without a message returned a plain-text 400; it now returns
  JSON like every other route.
- The repository's `doctor` script (`pnpm run doctor` — plain `pnpm doctor` is
  pnpm's own built-in command) crashed on startup: it ran TypeScript sources whose
  `.js` import specifiers only resolve after a build. It now builds and runs the
  compiled CLI.
- `doctor` probed every CLI seat with its default model, ignoring `cliModel`, so a
  seat that only works with its configured model always failed the check.
- **Audits and votes could edit the worktree.** Claude's read-only phases relied on
  its command allowlist but inherited the operator's own permission mode; with a
  global `"defaultMode": "auto"`, a ratifying seat ran `sed -i` on a source file to
  test the fix and restored it afterwards — while the other seats, voting
  concurrently in the same worktree, read the modified file and rejected the plan
  as describing code that wasn't there (found in a live three-provider run). Audit
  invocations now pin `--permission-mode dontAsk`.
- A permission denial no longer voids a seat's whole verdict and ejects it from
  the council; the denied command is recorded as `DENIED` (never evidence) and the
  verdict stands.
- **Seats were required to self-report token counts** (`raw_usage`) that no model
  can know and Conclave never uses. In the live run Claude omitted it five times
  and Claude Code gave up, failing a correct approval. It is no longer part of the
  schema models answer to (still accepted when present).
- **A seat failing mid-vote counted as consent.** A seat whose call failed was
  dropped from the council *before* its vote was tallied, so the remaining seats
  ratified "unanimously" — contradicting "a missing vote is never assent". The
  electorate is now fixed before each vote; the failed ballot blocks that vote,
  and later votes proceed without the seat.
- A CLI seat that failed with nothing on stderr was reported as a bare
  "exited 1:"; the error is now read from its stdout result record.
- `pnpm typecheck` failed on a fresh checkout (the orchestrator's types come from
  `@conclave/core`'s build output, which did not exist yet); it now builds core
  first.
- The install instructions said `npm install -g @conclave/orchestrator`, but the
  packages are private and unpublished; they now install from the release
  tarballs.
- `DEFAULT_SEATS` pointed at model ids that no gateway lists; they are now ids a
  real OmniRoute/Xenia gateway exposes, and the claim that they were resolved at
  startup (nothing did that) is replaced by `doctor`'s actual check.

### Verified

- Full workspace `typecheck`, `test` (222 tests, 0 failures), and `build` pass
  cleanly, both in the working tree and from a fresh clone of the release tag. The suite runs entirely offline, with file-level test concurrency
  bounded so subprocess-heavy council tests are not load-sensitive.
- End-to-end council runs covering: unanimous approval; a single seat objecting
  (contention → thread → arbitration → escalation → plan revision →
  superseded); falsifiable tests that reproduce, refute, or are inconclusive; a
  session stopping `AWAITING_HUMAN`, refusing to resume, taking a human ruling,
  and resuming to ratification; out-of-process cancellation; resume restoring
  the plan; a Xenia seat receiving the file list and diff; and pruning.
- The `xenia` adapter against a live OmniRoute gateway (2026-09-27): real
  responses parsed into valid verdicts, with usage and cost taken from the
  gateway's headers.
- Clean-install smoke tests from real `npm pack` tarballs (CLI `--help`,
  `doctor`, web server static/API routes) in a fresh, isolated directory, and a
  full CLI workflow test (`run → list → status → arbitrate → cancel → prune`).
- A real, non-mocked three-provider (Claude, Codex via an OmniRoute gateway,
  Antigravity) run on 2026-09-28 against a disposable repository with a real
  off-by-one bug: the council planned, audited, ratified, implemented, and
  re-audited; the delivered `conclave/<session>` branch holds a one-line fix,
  leaves the tests untouched, passes 4/4, and the source checkout was never
  modified ($4.23 of a $5 ceiling). The run surfaced the three bugs above
  (audit-time worktree edits, the `raw_usage` requirement, and failed ballots
  counting as consent), all fixed since.
- Release smoke test with the fixes in place: all three real seats auditing the
  same repository concurrently, prompted to "verify by editing in place" —
  every verdict parses under the new schema and the source is left untouched.
- `npm install -g` of the two release tarballs into a clean prefix, followed by
  a full `conclave run` → ratified → `conclave list` from the installed binaries.

### Known limitations

- **Arbitration rulings never call a model.** Verification asks a seat to run a
  falsifiable test, but the ruling is deterministic policy over findings and
  executed evidence: cheap, replayable, and testable, but unable to reason about
  a claim beyond its severity, confidence, and whether a test reproduced it.
- **Xenia routes depend on the gateway.** Only the gateway's Claude routes
  answered at verification time; the other providers behind it failed inside the
  gateway. `doctor` confirms a model is listed, not that its upstream answers.
- **Event logs are never pruned** — by design; they are the audit trail.
