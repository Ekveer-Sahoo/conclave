---
description: Gracefully cancel a running Conclave session
argument-hint: <session-id>
---

Cancel session $ARGUMENTS. If no id was given, list running sessions with `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" list` and ask which one. Confirm the session id with the user before cancelling, then run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" cancel <id>` and report the result. Mention it can be resumed later with `/conclave:resume`.
