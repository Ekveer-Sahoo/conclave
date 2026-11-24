---
description: Reclaim worktrees and snapshots kept by old, unratified Conclave sessions
argument-hint: --older-than <days> [--dry-run]
---

Arguments: $ARGUMENTS

1. If `--older-than` is missing, ask how many days of sessions to keep (suggest 14).
2. Always do a dry run first: `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" prune --older-than <days> --dry-run`, and show what would be removed.
3. Unless the user only asked for a dry run, confirm, then run it without `--dry-run`. The event log is kept; only worktrees and snapshots are removed.
