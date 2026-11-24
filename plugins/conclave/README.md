# Conclave plugin for Claude Code

Run the Conclave multi-model council from inside Claude Code: start sessions, watch them, settle disputes, and apply ratified work without leaving the chat.

```
plugins/conclave/
├── .claude-plugin/plugin.json   manifest
├── bin/conclave-cli             finds and runs the Conclave CLI / web server
├── commands/                    /conclave:* slash commands
│   ├── run.md        status.md   list.md     resume.md
│   ├── cancel.md     arbitrate.md apply.md   seats.md
│   └── doctor.md     web.md      prune.md
└── skills/council/SKILL.md      when and how Claude should use the council
```

The marketplace entry lives at the repository root in `.claude-plugin/marketplace.json`.

## Install

1. Install Conclave itself (Node.js 24+), either globally from the release tarballs:

   ```bash
   npm install -g ./conclave-core-0.1.0.tgz ./conclave-orchestrator-0.1.0.tgz
   ```

   or build this checkout (`pnpm install && pnpm build`).

2. Add the plugin to Claude Code:

   ```bash
   claude plugin marketplace add /path/to/conclave
   claude plugin install conclave@conclave
   ```

   For development, load it straight from the checkout instead:

   ```bash
   claude --plugin-dir /path/to/conclave/plugins/conclave
   ```

3. Inside Claude Code, run `/conclave:doctor`.

## How the CLI is found

`bin/conclave-cli` tries, in order:

1. `CONCLAVE_BIN` (or `CONCLAVE_WEB_BIN` for `--web`)
2. `conclave` / `conclave-web` on `PATH`
3. `$CONCLAVE_REPO/packages/orchestrator/dist/...`
4. The checkout the plugin sits in (works with `--plugin-dir`)

An installed plugin is copied into Claude Code's plugin cache, so option 4 only applies when loading from the checkout. Use 1, 2, or 3 otherwise.

## Commands

| Command | What it does |
| --- | --- |
| `/conclave:run "<task>"` | Convene a council in the background and report the session id |
| `/conclave:list` | Sessions in this repository |
| `/conclave:status [id]` | State, deliberation summary, and the next step |
| `/conclave:arbitrate <id>` | Explain contentions waiting on you and record your ruling |
| `/conclave:resume <id>` | Continue a crashed, cancelled, or ruled-on session |
| `/conclave:cancel <id>` | Stop a run gracefully |
| `/conclave:apply <id>` | Preview, then apply ratified work to a non-git folder |
| `/conclave:seats [...]` | Show or change seats and models |
| `/conclave:doctor` | Check every seat's provider |
| `/conclave:web [port]` | Start the web UI (default port 4317) |
| `/conclave:prune --older-than <days>` | Reclaim old worktrees (dry run first) |

Configuration (seats, budgets, gateway) is Conclave's own; see `packages/orchestrator/README.md`.
