# Conclave — Operator Guide

Conclave runs a multi-model council against a task in your repository. Claude plans; every seat
audits the plan; genuine disagreements are arbitrated (on executed evidence where possible, and by
you when a blocking dispute can't be settled automatically); the ratified plan is implemented in an
isolated git worktree; and the work is audited and remediated until the council ratifies it. This
guide covers installing, running, and operating Conclave — not its internal architecture.

## 1. Installation

Conclave ships as two tarballs (it is not published to the npm registry). Install both in one
command, so npm resolves the orchestrator's dependency on the core package from the tarball next to
it:

```bash
npm install -g ./conclave-core-0.1.0.tgz ./conclave-orchestrator-0.1.0.tgz
```

Requires Node.js 24 or later. `better-sqlite3` is a native module; npm downloads a prebuilt binary
for common platforms and falls back to compiling it (which needs a C++ toolchain) otherwise.

To build the tarballs yourself from a checkout:

```bash
pnpm install && pnpm build
(cd packages/core && pnpm pack) && (cd packages/orchestrator && pnpm pack)
```

This installs two executables:

- `conclave` — the CLI (`run`, `list`, `status`, `resume`, `cancel`, `arbitrate`, `prune`, `apply`, `seats`, `doctor`).
- `conclave-web` — the web UI server (backed by the same session engine and on-disk state).

Conclave has no database server or external service dependency — session state lives in local
SQLite files (see [Chat history and registry locations](#6-chat-history-and-registry-locations)).

### Verifying the install: `conclave doctor`

```bash
conclave doctor
```

`doctor` checks every configured seat the way that seat is actually invoked:

- **`cli` seats** (`claude`, `codex`, `antigravity`, `grok`): whether the CLI binary is on `PATH`, and
  whether it can actually respond (i.e. is authenticated). This probe is a real, tiny model call.
- **`xenia` seats**: whether the gateway answers and lists the seat's `xeniaModel` in `/v1/models`
  (no tokens spent). A missing model is reported with up to three close matches.
- **`fake` seats**: always healthy — they contact no provider.

```
OK               claude       (claude) — OK
FAIL             codex        (codex) — exit 1: not authenticated
        fix: codex login
MISSING          antigravity  (agy) — spawn agy ENOENT
```

It also fails if your seat configuration file exists but is invalid — Conclave would otherwise fall
back to the default seats and run a council you didn't configure. Exit code is `0` only if the
configuration is valid and every *enabled* seat is healthy; a seat you disabled is reported as
`(disabled)` and never fails the check. Run it after install, after changing seats, and whenever a
run reports a seat as unavailable.

## 2. Authenticating each provider

Conclave never stores provider credentials. CLI seats use each provider's own login:

| Seat | CLI binary | Install / authenticate |
| --- | --- | --- |
| Claude | `claude` | Install [Claude Code](https://claude.com/claude-code), then run `claude` once and complete its login flow. |
| Codex | `codex` | Install the OpenAI Codex CLI, then run `codex login`. |
| Antigravity | `agy` | Install the Antigravity CLI, then run `agy` and complete its interactive login (there is no separate `agy login` subcommand). |
| Grok Build | `grok` | Install xAI's Grok Build CLI, then run `grok login` (a grok.com sign-in or an xAI API key). |
| Xenia seats | — | Point `CONCLAVE_XENIA_BASE_URL` at an OpenAI-compatible gateway. If it enforces keys, set `CONCLAVE_XENIA_API_KEY` (sent as a bearer token, never logged). |

`conclave doctor` distinguishes "binary/gateway missing" (`MISSING`) from "present but failing"
(`FAIL`), and prints a `fix:` hint specific to the case.

## 3. CLI and web workflows

### CLI

```bash
conclave run "add rate limiting to the login endpoint" --cwd /path/to/repo --budget 5
conclave list                      # sessions in this repository, most recent first
conclave status <session-id>       # durable status as JSON
conclave resume <session-id>
conclave cancel <session-id>       # stop a run from another terminal
conclave arbitrate <session-id>    # show disputes waiting on you, or settle one
conclave prune --older-than 14 --dry-run
conclave seats                     # each seat and the model it uses (see §5)
conclave doctor
```

- `run` starts a session against `--cwd` (default: the current directory) and blocks until the
  council reaches a verdict. Exit code `0` means ratified; `1` means the council ran and did not
  ratify (not approved, awaiting a human ruling, cancelled, errored); `2` means the command itself
  was refused (a bad option, an unknown session, an invalid seat config). `--budget <usd>` sets the spend ceiling (default
  `20`). `--model <seat>=<model>` (repeatable) switches a seat's model for this council only. The
  session id is printed to stderr as soon as the run starts.
- `run`, like `doctor`, uses the seat configuration at `CONCLAVE_SEAT_CONFIG_PATH` (§5), so
  `doctor` never reports on a council other than the one `run` will use. If that file is invalid,
  `run` refuses to start rather than convening the default seats.
- Options are strict. `--db x` and `--db=x` both work; an unknown option (`--dryrun`), an option
  missing its value, and a non-numeric `--budget` or `--limit` are refused with exit code `2` before
  anything runs; `-h`/`--help` anywhere prints help and runs nothing. A task that itself starts with
  `-` goes after `--`.
- **`--db` is optional everywhere.** `run` registers every session in the session registry (§6),
  so `status`, `resume`, `cancel`, and `arbitrate` find a session's event store from any directory.
  Without a registry entry they fall back to `<cwd>/.conclave/events.db`. `list` and `prune`
  operate on one event store: `--db`, or the current repository's.
- `status` includes `state` (`running`, `approved`, `not_approved`, `awaiting_human`,
  `cancelled`, `errored`), whether a process is `running` it right now, the `outcome` and its
  reason, contentions `awaitingHumanRuling`, and a `deliberation` summary (findings by severity and
  how many were addressed, contentions, arbitration rulings including human ones, falsifiable-test
  verifications, and per-round ratification tallies).
- `--allow-dirty-source` permits running against a working tree with uncommitted changes (normally
  refused — see §8). Conclave's own `.conclave/` directory never counts as uncommitted.
- `Ctrl-C` during `run`/`resume` cancels the session gracefully (see §7) rather than killing it
  mid-write. So does closing the terminal (SIGHUP): the seats' own processes are stopped with it
  rather than left running.

### Web

```bash
conclave-web            # listens on 127.0.0.1:4317 by default
```

Open `http://127.0.0.1:4317`. Choose the folder in the New council sheet by typing a path (`~`
works), picking a recently used one, or **Browse…**-ing your folders (git repositories are marked).
The sheet says what you picked as you pick it. A subfolder of a repository means its whole
repository. A repository with uncommitted changes can still be used by ticking "Run anyway"; the
council works from your last commit either way, so those changes are not part of what it sees. Any
other folder works too — see [Folders that aren't git repositories](#folders-that-arent-git-repositories).
Send a task to convene the council; the session's activity streams
live over Server-Sent Events. For any session you can see its findings, contentions and their
threads, arbitration rulings, verification runs, and ratification tallies; cancel it while it runs;
resume it when it's orphaned, cancelled, errored, or no longer waiting on you; and settle escalated
contentions with **Uphold** / **Dismiss**. Seats are listed from your configuration (any number,
any adapter) with their health; health is checked on load and when you click **Recheck** — never on
a timer, because a CLI health probe is a billed model call. The web UI and the CLI share the same
session registry, so sessions started from either show up in both.

### Folders that aren't git repositories

Conclave isolates the council's work with git, but your folder doesn't need to be a repository.
For a plain folder (or a repository with no commits yet), Conclave takes a private snapshot of it —
a git repository under `~/.conclave/snapshots/<session-id>` (or `CONCLAVE_SNAPSHOT_DIR`), built by
reading your folder without writing to it; your folder never gets a `.git`. The snapshot honours any
`.gitignore` in the folder and leaves out `node_modules`, virtualenvs and caches. It refuses, before
copying anything, a folder of more than 50,000 files or 1 GB (add a `.gitignore`), a folder that
contains other git repositories (run Conclave on each one instead: a snapshot cannot include them),
and a folder with symlinks that point outside it (a seat could edit the real files through them).
The council then runs exactly as it does on a repository, and your folder is not modified.

A folder inside a git repository runs on that repository when it is the repository's content — its
root, or a folder with tracked files. A folder the repository ignores or doesn't track (a project
under a dotfiles-managed home, say) runs on a snapshot instead, so the council sees its files.

Ratified work stays in the snapshot until you apply it:

```bash
conclave apply <session-id> --check    # list what would change, write nothing
conclave apply <session-id>
```

or **Apply to folder** in the web UI, which previews the files first (`--dry-run` is an alias for
`--check`). Applying writes exactly the council's changes against the snapshot it started from. If
you edited any of the same lines in the meantime, it refuses, names the files, and writes nothing; if
a write fails partway (a read-only file, a full disk), every file is put back. A session's changes
can be applied once, and two applies of the same session cannot run at the same time.
`conclave prune` removes unratified snapshot sessions' worktrees and their snapshots.

## 4. Budgets, spend limits, and approval

- **Per-session budget ceiling** — default $20, `--budget` on the CLI or `budgetCeilingUsd` when
  embedding. Spend is taken from the provider's own reported usage (or the gateway's cost header
  for Xenia seats), falling back to a local estimate. A call that failed but was billed (a timeout,
  an unusable answer) is charged what the provider reported; a call whose provider reported no usage
  is charged a conservative estimate (its prompt plus its whole output allowance), never zero.
  Every call is recorded before the ceiling is checked, no new call starts once it is reached, and
  a session that crosses it concludes **NOT APPROVED** with the reason recorded; it is not treated as
  a crash, and it cannot be resumed (start a new council with a higher `--budget`).
- **Rolling spend limits across all sessions** — `POST /api/chat` (the web UI) enforces a 5-hour
  and a weekly ceiling before starting a new run, returning HTTP `429` once reached:
  `CONCLAVE_LIMIT_5H_USD` (default `10`) and `CONCLAVE_LIMIT_WEEKLY_USD` (default `50`). Calls whose
  provider reported no usage count as zero rather than disabling the limit. Check standing with
  `GET /api/usage`.

**Approval requires a formal ratification vote.** Both `RATIFY_PLAN` and `RATIFY_WORK` require
every currently-active seat to vote, with a minimum quorum of `min(2, configured seats)`:

- A **missing vote is never counted as assent** — an outage must not be able to approve work.
- A single **REJECT** blocks ratification regardless of how many seats approve.
- **`APPROVE_WITH_CHANGES` ratifies only when nothing is still open.**
- Any **open BLOCKER or MAJOR contention blocks ratification** outright.

A failed vote is not the end of the round: the dissenting seats' objections go to the executor as a
remediation round (plan side: a refinement), and the council votes again, within the round caps.

A seat that fails a call drops out of the council for the rest of the run rather than blocking it —
but if fewer than the minimum quorum remain, the run stops with an explicit error rather than
approving on partial input. A resume gives every configured seat another chance.

### Disagreement, verification, and arbitration

When seats genuinely disagree about the same target — one files a BLOCKER or MAJOR finding where
another approves — Conclave opens a **contention** instead of letting the majority win. A material
defect that **every** active seat agrees on is not a contention; it goes straight to remediation.

Each contention is settled in this order:

1. **Executed evidence.** If a claim carries a `falsifiable_test`, a seat with no stake in the
   dispute that can run commands (Claude, then Codex) is asked to run it without editing anything.
   It only counts as evidence if a command demonstrably executed: a reproduction upholds the claim,
   a clean run dismisses it, anything else is inconclusive. Up to three such verifications run per
   deliberation round.
2. **A human ruling**, if you have already given one on these same claims (see below). Later rounds
   honor it instead of re-arbitrating the same dispute. A ruling covers the claims it was made on:
   a different problem later found in the same file is arbitrated on its own merits.
3. **Weighted policy**: severity × confidence against the dissenting seats.
4. **A contested BLOCKER is never auto-dismissed.** If the evidence and weights are inconclusive, it
   escalates to `HUMAN_ARBITRATION` and keeps blocking approval.

The council keeps working on an escalated contention — the plan or work is revised, and an issue
that later audits no longer raise is closed as `SUPERSEDED`. If the rounds run out while a
contention is still escalated, the session stops as **AWAITING HUMAN ARBITRATION** (worktree
preserved) instead of failing:

```bash
conclave arbitrate <session-id>                       # shows each disputed contention and its thread
conclave arbitrate <session-id> c-1a2b3c dismiss --reason "auth is enforced at the gateway"
conclave resume <session-id>
```

Upholding means the objection is valid and must be fixed; dismissing means it is not. Either way
your reason is shown to every seat in later rounds, so a dismissed objection is not simply raised
again. When you uphold one, the resumed session starts by fixing it (a plan refinement or a
remediation round) and gets one more round to do so. A session awaiting a ruling refuses to resume
until every escalated contention has one. You can also rule while a session is still running; the
next deliberation round picks it up.

## 5. Configuring seats

Seat configuration is a JSON file at `CONCLAVE_SEAT_CONFIG_PATH` (default
`~/.conclave/seat-config.json`), editable directly or via the web UI (`GET`/`PUT /api/seats`). The
default is `DEFAULT_CLI_SEATS` from `@conclave/core` (`claude`, `codex`, `antigravity`, `grok`). The file is
`{"version": <number>, "seats": [...]}` and every seat is validated against the seat schema when it
is loaded. An invalid file is reported by `doctor` and the web UI, and nothing uses the fallback
defaults silently: `conclave run` refuses to start, `doctor` probes nothing, and a `conclave seats`
change or a web UI save refuses to overwrite it (`--replace-invalid` does so deliberately, keeping the
old file as `seat-config.json.invalid-<time>`). Unknown settings (usually typos) are reported as
warnings. The CLI and the web server share the file: each picks up the other's saves, and a save
based on a version that has since changed is refused rather than overwriting it.

Each seat's `adapter` selects how it is invoked:

| Adapter | How it runs | Notes |
| --- | --- | --- |
| `cli` | Spawns the provider's own CLI (`cliCommand`, optional `cliModel`, optional `cliExtraArgs`, or a full `cliArgsTemplate`). | What the default council uses. Claude, Codex and Grok Build seats also have the commands they run captured as verification evidence. |
| `xenia` | POSTs to an OpenAI-compatible gateway at `CONCLAVE_XENIA_BASE_URL` (default `http://localhost:20128`), model selected by `xeniaModel`. | Verified against a live OmniRoute gateway (2026-09-27). These seats have no filesystem: Conclave sends them the repository's file list, and on the work side the full diff so far. Pin explicit model ids — `auto/*` routes vary in cost by an order of magnitude. |
| `fake` | Deterministic in-process stub. Approves unless scripted otherwise. | For tests and dry runs — contacts no provider and spends nothing. |

A council can mix adapters, e.g. the `claude` CLI seat plus Xenia reviewers from `DEFAULT_SEATS`.

### Switching models

Every seat's model can be changed without editing JSON, and every change can be tried first:

```bash
conclave seats                          # each seat, on/off, and its model ("default model" = the CLI's own)
conclave seats models codex             # what codex can switch to, and where that list comes from
conclave seats set codex gpt-6-sol      # applies to new councils
conclave seats test codex               # one small, billed call with exactly the flags a run uses
conclave seats reset codex              # back to the CLI's default model
conclave seats add grok                 # add a built-in seat your saved config predates
conclave run "…" --model claude=claude-opus-5-5   # this council only
```

Where each seat's list comes from:

| Seat | List | Notes |
| --- | --- | --- |
| Xenia seats | The gateway's `/v1/models` | Authoritative: an unlisted id is refused unless you pass `--force`. Listed is not the same as working — test it. |
| Antigravity | `agy models` | Authoritative. |
| Grok Build | `grok models` (its default marked) | Any id Grok accepts works, including custom models from your Grok config. |
| Codex | When `~/.codex/config.toml` routes Codex through a custom provider (e.g. a gateway), that provider's `/models`, as the bare ids Codex sends; otherwise Codex's own model cache for your account. The config's `model` is shown as the default. | Any id Codex accepts works. |
| Claude | Known Claude model ids and the `fable`/`opus`/`sonnet`/`haiku` aliases | Claude Code has no list command. Aliases follow your Claude Code settings, which can remap them; a full id is exact. |

In the web UI, Council settings has a model dropdown listing the seat's whole catalog (the CLI's
default first, then the models; **Custom id…** takes any other id), a note on where the list comes
from, a warning when an authoritative list does not include a custom id, and a **Test** button (the
same billed probe). The New council sheet's **Models for this council** section switches models
for one council.

A per-council model is recorded with the session, so resuming it uses the same models. Every seat
call also records the model the provider **reports actually answering** — Claude Code names it in
its output, as does Grok Build, and a gateway names the upstream it routed to — next to the model Conclave asked for.
The seat rail and `report.md` show that model, so an alias or an `auto/*` route never hides what
really ran. (Codex does not report its model in machine-readable output; for it, the requested or
configured model is what is shown.)

`cliModel` and `cliExtraArgs` let one Conclave seat differ from how you use that CLI day to day,
without touching its global config. For example, if `~/.claude/settings.json` routes Claude Code
through a gateway whose model aliases (`cc/…`) your own login doesn't recognize, give the seat a
real model id; and if `~/.codex/config.toml` sends Codex through a gateway, bypass it for this seat:

```json
{ "id": "claude", "adapter": "cli", "cliCommand": "claude", "cliModel": "claude-sonnet-5", "role": "ARCHITECTURE" },
{ "id": "codex", "adapter": "cli", "cliCommand": "codex", "cliModel": "gpt-5.6-terra",
  "cliExtraArgs": ["-c", "model_provider=openai"], "role": "CORRECTNESS" }
```

`doctor` probes each seat with its `cliModel` and `cliExtraArgs`, so it checks exactly what a run uses.

**Claude must stay enabled**: it is the only seat that plans, executes, and remediates. A
configuration without it is refused at startup.

## 6. Chat history and registry locations

| What | Where | Notes |
| --- | --- | --- |
| Per-session event log | `<repo>/.conclave/events.db` (default) or wherever `--db` placed it | SQLite, append-only, the source of truth for a session: messages, phases, verdicts, findings, rulings, spend. |
| Session registry (discovery index) | `~/.conclave/registry.db`, or `CONCLAVE_SESSION_REGISTRY_PATH` | Maps `sessionId → event store` for sessions started from the CLI or the web UI, across repositories. An index, not the source of truth — see §9. |
| Seat configuration | `~/.conclave/seat-config.json`, or `CONCLAVE_SEAT_CONFIG_PATH` | See §5. |
| Per-session lock | `<event-store-dir>/.locks/<sessionId>.lock` | PID of the process running the session; used for orphan detection. Removed on clean exit; stale after a crash. |
| Cancel request | `<event-store-dir>/.locks/<sessionId>.cancel` | Written by `conclave cancel`; the running process polls for it and removes it. |
| Plan, diff, and report artifacts | `/tmp/conclave-<sessionId>-artifacts/` | `plan.vN.md`, `changes.diff`, `report.md`. Hashes and paths are recorded in the event log. |

`conclave status <id>` gives the durable projection; `GET /api/sessions/:id/messages` gives the raw
activity transcript.

## 7. Cancellation, crash recovery, orphaned sessions, and resume

- **Cancellation**: `Ctrl-C` on the CLI; `conclave cancel <id>` from any other terminal (works for
  sessions run by the CLI *or* the web server); or the web UI's **Cancel** (`POST
  /api/sessions/:id/cancel`). The abort is cooperative — the current seat call is given a bounded
  window to unwind — the worktree is preserved, and the reason for the cancellation is recorded.
- **Process crash / kill**: if the process dies mid-session, the event log stops mid-phase and its
  lock file is left behind with a dead PID.
- **Orphan detection**: session listings report `orphaned` when a session has no terminal outcome
  *and* no live process holds its lock — "abandoned, needs a resume" rather than "still running".
- **Resume**: `conclave resume <session-id>` (or the web UI's **Resume**) continues from the last
  durable phase boundary. It never re-runs a phase that may have edited files (an interrupted
  EXECUTE or REMEDIATE resumes into a fresh audit of what was written), and it restores the
  council's working state from the event log: the current plan, every finding, and all verification
  evidence. Prior spend counts against the same budget.

## 8. Preserved worktrees, retention, and cleanup

Every session executes inside an isolated git worktree on a `conclave/<session-id>` branch; your
working tree and index are never touched. By default `run` refuses a dirty working tree —
`--allow-dirty-source` overrides that.

- **On ratification**: the worktree's changes are committed to the session branch and the worktree
  is removed. The branch is the deliverable — review and merge it yourself; Conclave never merges
  or pushes.
- **Otherwise** (not approved, awaiting a ruling, cancelled, errored): the worktree is kept so you
  can inspect exactly what was produced.
- **Retention**: `conclave prune --older-than <days>` removes worktrees kept by sessions with no
  activity for that long, and deletes their session branch only if it holds no commit of its own.
  It never touches a session a live process is running, or a ratified session's branch. The event
  log is kept — pruning appends a `WorktreeRemoved` record rather than deleting history — so the
  session still reports how it ended; it just can't be resumed. Use `--dry-run` first.

## 9. Registry corruption: quarantine and repair

The session registry is a discovery index; each session's own `events.db` is authoritative. If the
registry is unreadable or fails SQLite's `integrity_check` on open, Conclave renames it aside as
`registry.db.corrupt-<timestamp>` and starts a fresh one rather than crashing. Sessions known only
through the quarantined file disappear from listings until re-registered; act on them directly
with `--db <path>` (`status`, `resume`, `cancel`, `arbitrate` all accept it).

## 10. Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONCLAVE_PORT` | `4317` | Port `conclave-web` listens on. |
| `CONCLAVE_SESSION_REGISTRY_PATH` | `~/.conclave/registry.db` | Session registry location (§6). |
| `CONCLAVE_SEAT_CONFIG_PATH` | `~/.conclave/seat-config.json` | Seat configuration location (§5). |
| `CONCLAVE_LIMIT_5H_USD` | `10` | Rolling 5-hour spend ceiling across all sessions (§4). |
| `CONCLAVE_LIMIT_WEEKLY_USD` | `50` | Rolling weekly spend ceiling across all sessions (§4). |
| `CONCLAVE_XENIA_BASE_URL` | `http://localhost:20128` | Gateway for `xenia` seats (§5). |
| `CONCLAVE_XENIA_API_KEY` | — | Bearer token for gateways that require one. Never logged. |
| `CONCLAVE_AUTH_STATUS_TTL_MS` | `600000` | How long the web server caches seat health before re-probing. |
| `CONCLAVE_DISABLE_STREAM_CAPTURE` | — | Set to `1` to run the Claude seat with plain JSON output instead of stream-json (loses command capture). |

## 11. Security and data-retention boundaries

- **No secrets are collected by Conclave itself** — CLI seats use their own credential stores; the
  optional Xenia key is read from the environment and sent only to the configured gateway.
- **Quoted material is framed as data, not instructions.** Every seat prompt states that plans,
  diffs, file contents, other seats' reasoning, and command output are material to evaluate and that
  directives inside them must be ignored. This reduces, but cannot eliminate, prompt-injection risk
  from a hostile repository — the executor runs with edit permission inside the worktree.
- **Browser-facing output is redacted**: chat messages and session details sent to the web UI have
  absolute paths (repository, worktree, artifacts) removed and AWS keys, PEM private keys,
  `sk-`/`pk-`/`rk-` tokens, and `key=value` secrets stripped, and free text is length-capped. The raw
  event-log projection never leaves the server.
- **Everything stays local by default** — sessions, chat history, and worktrees are local SQLite and
  filesystem state. Nothing is sent anywhere except to the provider CLIs and gateway you configured.
- **Isolated execution** — changes happen in a disposable worktree, never in your checkout.
- **HTTP hardening** — the server binds to `127.0.0.1` and only answers requests addressed to its own
  loopback host, which defeats DNS rebinding. A browser request carrying any other site's `Origin` is
  refused, so a web page you happen to visit cannot start a council, record a ruling, change seats,
  or list your folders. Request bodies are capped (clean `413`), a session's `cwd` is resolved to its
  canonical real path, and static-asset path traversal is refused.
- **Retention** — event logs are kept indefinitely (they are the audit trail); preserved worktrees
  are pruned on request (§8). Treat `~/.conclave/` and each repository's `.conclave/` as data you are
  responsible for retaining or deleting.

## 12. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `doctor` reports `MISSING` for a CLI seat | CLI not installed / not on `PATH` | Install it (§2), re-run `doctor`. |
| `doctor` reports `FAIL` for a CLI seat | Installed but not authenticated, or erroring | Re-run that provider's login flow (§2); check the `fix:` hint. |
| `doctor` reports a Xenia model missing | The gateway doesn't list that `xeniaModel` | Pick one of the suggested ids (or any from `<gateway>/v1/models`). Listed doesn't guarantee the upstream answers — a first run confirms it. |
| `doctor` reports `seat-config` invalid | A typo in `seat-config.json` | Fix the reported field; until then `run` refuses to start. |
| A run stops AWAITING HUMAN ARBITRATION | A contested BLOCKER survived every round | `conclave arbitrate <id>`, rule on each contention, then `conclave resume <id>` (§4). |
| A run ends NOT APPROVED "contentions unresolved" or "not ratified" | The council never converged within its round caps | Read `deliberation` in `conclave status`; the plan may be genuinely wrong or one seat miscalibrated for the task. Inspect the preserved worktree. |
| A run stops for quorum | Too many seats failed mid-run | Fix the failing seats (`doctor`), then `conclave resume`. |
| `POST /api/chat` returns `429` | 5-hour or weekly spend limit reached | Check `GET /api/usage`; wait for the window, or raise the limits. |
| `resume` says the worktree was removed | The session was pruned (or ratified) | Its history is still in `status`; start a new run instead. |
| `cancel` says the session is not running | No live process holds its lock | Nothing to cancel; if it shows `orphaned`, `resume` it instead. |
| Session list is missing sessions you know exist | Registry was quarantined after corruption | See §9 — act directly via `--db <path>`. |
| Web UI won't start / port in use | Another process already bound the port | Set `CONCLAVE_PORT` to a free port. |
| Old worktrees piling up in `/tmp` | Expected — unratified sessions keep theirs | `conclave prune --older-than <days>` (§8). |
