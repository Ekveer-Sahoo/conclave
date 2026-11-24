---
description: Preview and apply a ratified Conclave session's changes to a non-git folder
argument-hint: <session-id> [--check]
---

Session: $ARGUMENTS

1. Always preview first: `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" apply <id> --check`. Show the list of files that would change.
2. If the user passed `--check`, stop there.
3. Otherwise, ask the user to confirm, then run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" apply <id>`. If it refuses because the user edited the same lines since the council started, name the conflicting files and stop. Nothing was written in that case.

Only sessions that ran on a plain folder (a snapshot) need this. Sessions on a git repository leave their work on the `conclave/<session-id>` branch instead: point the user there.
