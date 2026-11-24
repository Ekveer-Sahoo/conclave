---
description: Resume a Conclave session that crashed, was cancelled, or awaited a ruling
argument-hint: <session-id>
---

Session: $ARGUMENTS

1. If no id was given, ask for one (offer `/conclave:list`).
2. Check `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" status <id>` first. A session that exceeded its budget cannot be resumed: say so and suggest a new `/conclave:run` with a higher `--budget`. A session already running in another process should not be resumed twice.
3. Otherwise run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" resume <id>` **in the background** and report the result when it ends, using the same exit-code meaning as `/conclave:run` (0 ratified, 1 not ratified, 2 refused).
