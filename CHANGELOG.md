# Changelog

All notable changes to Conclave are documented in this file.

## [Unreleased]

### Fixed

Found by a five-agent bug hunt (event log and engine; council driver; seats and CLI; HTTP server
and git; web UI): 92 findings, each reproduced (or traced in the code) before it was fixed, with
regression tests in `test/{session,seats,worktree}/regressions.test.ts` and alongside the existing tests.

**Council correctness**
- One steady REJECT in the work ratification vote looped WORK_REFINE → RATIFY_WORK at the same round
  until the 200-step guard errored the session (spending the budget on repeat votes). A failed vote
  now goes to remediation in the next round, with the dissenters' reasons as the objections.
- Evidence about one claim settled a different claim that reused its id (models number findings
  "F1" afresh every answer): a refuted plan claim dismissed a later SQL-injection BLOCKER unverified.
  A different claim reusing an id now gets its own (`codex:F1~2`); the same claim keeps its evidence.
- A human ruling closed every later dispute on the same file (contention ids are a hash of the
  target). A ruling now covers only the claims it was made on.
- Upholding an escalated dispute could never be acted on: resume re-audited at the exhausted round
  and ended NOT APPROVED. Resume now starts by fixing the upheld claims, with one more round.
- An escalated BLOCKER was closed as "superseded" when its claimant merely timed out on the next
  audit, and the remaining seats ratified past it. An escalation now closes only when its claimant
  answered without raising it, and a dispute awaiting a human blocks ratification.
- Refuting one tested claim dismissed a whole contention, untested BLOCKERs in it included; now
  every claim must be refuted. Evidence gathered before EXECUTE or a remediation settled the same
  claim afterwards; evidence now counts only against the code it ran on (a recorded tree hash).
- A later policy ruling on another claim in the same file erased a human's ruling (and the summary
  miscounted rulings); rulings are now kept per claim, recorded with the claims they cover, in a
  transaction. A reopened contention starts its own thread.
- A vote that failed only because a ballot was missing sent the executor to edit approved work with
  "(none recorded)"; the council now simply votes again. A resume after a ratified plan vote never
  reached EXECUTE (`"RATIFIED"` compared against `"ratified"`). A clock step backwards could make a
  latency negative and error the run; latency is now monotonic.
- A flaky first verification outvoted the refutation that followed it; a conclusive result now
  supersedes earlier inconclusive ones. A bare REJECT had zero weight in arbitration and showed as
  "objects to __overall__"; it is now a recorded finding carrying the seat's reasoning.

**Budget and spend**
- Billed calls went unrecorded: seats after the one that crossed the ceiling, calls finished just
  before a cancel, and failed calls (timeouts, unusable answers — providers bill those too). Every
  call is recorded before the ceiling is checked, failed calls are charged what the provider
  reported, no call starts once the ceiling is reached, and a spent session can't be resumed.
- A call with no reported usage cost $0 and bypassed the ceiling; it is now charged an estimate.
- Claude's cache-creation tokens were left out of prompt tokens.

**Robustness**
- The web server could be crashed by a council that failed before it started (a hand-edited
  config disabling Claude; a file appearing between the dirty check and the run), by a failed
  resume whose store was unreachable, and by a static file vanishing mid-send. Each is now recorded
  or contained.
- Two convenes (or a convene and a resume) arriving together both started; the second is refused.
- Two applies of the same session could both write; apply now holds the session lock. An apply that
  fails partway puts every file back. Apply builds its patch independent of the user's git config
  (`diff.noprefix` wrote changes to the wrong file) and reports file names verbatim.
- Ratification failed in repositories with commit hooks (commitlint, lint-staged) or GPG signing;
  Conclave's own commits skip both.
- A resume evicted every seat that had ever failed once, stranding small councils below quorum.
- A cancel issued while the worktree or snapshot was being created was silently dropped.
- A listener failing after the verdict was recorded turned an approved session into an errored one.
- A lock whose pid was reused after a crash stranded its session forever; locks now carry a
  heartbeat. Prune holds the session lock while it deletes a worktree.
- Closing the terminal (SIGHUP) orphaned running seat processes; timed-out health probes and model
  listings left their process trees running.

**Git and snapshots**
- A folder inside an unrelated parent repository (a project under a dotfiles-managed home) ran on
  the parent's tree and never saw its own files; it now runs on a snapshot.
- A plain folder containing other git repositories silently lost their files (or failed with a raw
  git error); it is refused with a clear message. Symlinks pointing outside the folder or repository
  (through which a seat could edit real files, invisibly to the diff) are refused.
- The review diff showed tracked-but-ignored files as deleted. A repository with a branch named
  `conclave` could not run councils. Oversized folders are refused before anything is copied, and
  failed snapshots are cleaned up.

**Seats and CLI**
- An invalid seat config silently fell back to the default (billed) seats for `run`, `doctor` probes
  and `seats` edits — which then overwrote the user's file. Now `run` refuses, `doctor` probes
  nothing, and writes refuse unless `--replace-invalid` (the old file is kept as a backup).
- The CLI and the web server overwrote each other's seat changes; each now sees the other's saves
  and refuses a save based on a stale version. Saves are validated; unknown settings are reported.
- `conclave run --help` started a council; `--flag=value` was ignored (and leaked into the task);
  unknown options were ignored (`apply --dry-run` applied the changes). Options are now strict.
- `$&`, `$$` and similar in a prompt were rewritten for template seats; a Codex verdict in a code
  fence was rejected as malformed; seats renamed from `codex`/`claude`/`agy` lost their CLI flags,
  usage metering and cost; health probes ignored argument templates and lacked
  `--skip-git-repo-check`; stderr in errors was unbounded and unredacted; timeouts above ~24.8 days
  fired at once; a gateway URL ending in `/v1` became `/v1/v1`; Codex's config was misread (single
  quotes, profiles, commented headers, a seat's own `-c` flags); an empty `agy models` blocked every
  switch; seat ids like `toString` broke every run.

**Security and privacy**
- Seat health refresh (a billed call per CLI seat) was a GET any page could trigger with an `<img>`
  tag; it is now a POST, and requests a browser marks as cross-site or same-site are refused.
- Verdicts reached the browser unredacted and uncapped; secrets in common forms (`OPENAI_API_KEY=…`,
  JSON `"api_key"`, `Bearer …`, GitHub, Slack, JWTs) slipped past redaction; the session list, apply
  errors and snapshot paths leaked absolute paths.

**Web UI**
- Enter on the "Run anyway" checkbox convened a council; "Run anyway" stayed ticked across councils
  and folders. Ruling drafts could land in a different dispute's box after an earlier ruling was
  recorded. Esc discarded unsaved settings. A failed timeline load showed "Nothing recorded yet" and
  never retried or went live. A resume could bind one session's stream to another's view. "Needs
  you" counted sessions that can no longer be resumed. Focus dropped to the page after several
  actions. Also: a request body split mid-character was corrupted; `null` bodies and fractional
  limits were 500s; an SSE stream for a deleted store reconnected forever; symlinked folders were
  missing from the folder browser; `conclave list` in a fresh repository errored.

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
- **Model switching**: `conclave seats` lists each seat's model and switches,
  tests, resets, enables, or disables seats without editing JSON; `conclave run
  --model <seat>=<model>` and the web UI's "Models for this council" switch a
  seat for one council, recorded with the session so a resume keeps it. Each
  seat has a model catalog with its provenance — the gateway's `/v1/models` and
  `agy models` (authoritative), Codex's account cache plus its configured
  default, known Claude ids and aliases — and a Test action that makes one
  small, billed call exactly as a run would (a real completion for gateway
  seats: listed is not the same as working). In the web UI each seat's model is
  a dropdown of its whole catalog (grouped: Claude models vs. aliases, gateway
  models by provider) with "Custom id…" for anything unlisted. Every seat call records the model
  the provider reports actually answering next to the one requested, shown in
  the seat rail and the report, so aliases and `auto/*` routing never hide what
  ran. `doctor` shows each seat's model.
- **Folders that aren't git repositories**: a plain folder (or a repository
  with no commits) runs on a private snapshot of it — a git repository under
  `~/.conclave/snapshots`, built by reading the folder without writing to it — so
  the council gets the same isolation, diffing, and resume as on a repository.
  Ratified work is written into the folder only on request (`conclave apply`,
  or "Apply to folder" in the web UI, previewed first), exactly once, and with
  context checking: if the folder was edited in the same places since the
  snapshot, nothing is written and the conflicting files are named. A new
  `ChangesApplied` event records it.
- **Choosing a repository in the web UI**: type a path (`~` expands), pick a
  recently used repository, or browse folders with git repositories marked. The
  sheet inspects the folder as it is chosen (not a repository, no commits,
  uncommitted changes) and the server refuses an unusable one with a clear
  message instead of recording a session that can only fail. A subfolder runs on
  its repository; a repository with uncommitted changes can be used by opting in.
- **Per-seat CLI options**: `cliExtraArgs` (e.g. codex's `-c
  model_provider=openai`) lets a Conclave seat bypass a gateway or override a
  provider setting without editing that CLI's global configuration.
- **Adapter-aware `doctor`**: CLI seats get the existing login probe, run with
  the seat's own `cliModel` and `cliExtraArgs` so it checks what a run uses; Xenia
  seats are checked against the gateway's `/v1/models` without spending tokens
  (with close-match suggestions); fake seats always pass. An invalid seat
  configuration file fails `doctor` instead of silently running the defaults.
- **Web app** (`conclave-web`), redesigned after two independent reviews (visual
  design, and UX/information architecture):
  - A session header that tells the truth at a glance — "Ratified by 2 of 3
    seats", which seat dropped out and where, plan revisions, resolved
    rejections — and becomes the ruling card when the council is waiting on you,
    or a phase stepper with "Stop run" (confirmed) while running. Resume is shown
    only when the server will accept it, with where it continues from and the
    budget left.
  - Overview · Timeline · Findings · Disputes. The timeline groups each phase
    into a card, collapsed when the seats agreed and expanded on dissent, with
    safe markdown rendering; a per-session seat rail says what each seat did and
    spent, and filters the timeline.
  - Sessions grouped into Needs you / Running / Earlier, with repository,
    relative time, and spend. "New council" (shortcut `N`) and council settings
    are sheets; settings save only on an explicit Save, and seat health is
    rechecked (a billed call per CLI seat) only on request.
  - A coherent design-token system (type, spacing, colour roles, six status
    families, radii) in light and dark; sentence-case labels, no text under 12px,
    WCAG-contrast inputs, visible focus, focus-trapped dialogs, attention-aware
    tab titles and live-region announcements.
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

- Pressing **Enter** in the New council sheet's folder field submitted the form,
  convening a billed council. Only Ctrl/⌘+Enter or the Convene button does now.
- A seat whose model was already set (e.g. Claude with `claude-sonnet-5`) showed
  **no other models** in the web UI: suggestion lists only show entries matching
  the text already in the field. The model is now a dropdown of the full catalog.
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
- **Findings were credited to whoever the model claimed to be** ("verifier",
  "plan-reviewer") and keyed by model-chosen ids, so two seats' "F1" overwrote
  each other — and contention detection, which reads a finding's seat to decide
  who objected, could misattribute a dispute. Findings are now attributed to the
  seat that returned them, with seat-namespaced ids.
- **Spend meters under-reported and limits were per-repository**: `/api/usage`
  read only the most recently active repository's log, and the 429 limits
  counted only the repository being started. Both are now account-wide.
- **Opening the web UI could spend money**: a page load after the health cache
  expired re-ran the billed CLI health probes. A page load now never probes CLI
  seats; only an explicit "Recheck" does.
- Vote tallies merged a re-vote held in the same phase and round into one
  tally (a 3-seat council could show "4 approve"); every vote is now its own
  ballot. Resuming a pruned session that had failed or been cancelled said it
  had "already completed successfully"; it now says the worktree was removed.
  Verification runs record which seat ran the test, and the session list says
  which sessions are resumable. Findings in older logs that a model credited to
  a made-up seat are attributed to the seat whose call recorded them.
- Browser-facing text showed a raw `<path>` placeholder and model-echoed schema
  tags (`</verdict_reasoning>`); paths now read `[repository]` / `[worktree]` and
  the tags are stripped. Reports show spend to the cent.
- **Any website could drive the web server** (CSRF): the server never checked
  where a request came from, so a page visited while `conclave-web` ran could
  POST to `127.0.0.1` and start a billed council. Requests whose `Host` is not the
  server's own loopback address (DNS rebinding) or whose `Origin` is another site
  are now refused.
- The Codex seat's model list was empty whenever Codex routes through a gateway
  (its own model cache only fills from OpenAI directly); it now lists the models
  that provider serves for Codex.
- The web UI's project directory treated `.` as the server's own folder, did not
  expand `~`, and could not use a repository with uncommitted changes at all.
- The install instructions said `npm install -g @conclave/orchestrator`, but the
  packages are private and unpublished; they now install from the release
  tarballs.
- `DEFAULT_SEATS` pointed at model ids that no gateway lists; they are now ids a
  real OmniRoute/Xenia gateway exposes, and the claim that they were resolved at
  startup (nothing did that) is replaced by `doctor`'s actual check.

### Verified

- Full workspace `typecheck`, `test` (292 tests, 0 failures), and `build` pass
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
