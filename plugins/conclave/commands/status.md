---
description: Show the durable status of a Conclave session
argument-hint: [session-id]
---

Session: $ARGUMENTS

1. If no session id was given, run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" list --limit 5` and use the most recent session (say which one you picked).
2. Run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" status <session-id>` and parse the JSON.
3. Summarize for the user, briefly:
   - **State** (`running`, `approved`, `not_approved`, `awaiting_human`, `cancelled`, `errored`), whether a process is running it now, and the outcome reason.
   - **Deliberation**: findings by severity and how many were addressed, open contentions, arbitration rulings (including human ones), verifications run, ratification tallies per round.
   - **Next step**: `awaiting_human` → `/conclave:arbitrate`; orphaned, cancelled, or errored → `/conclave:resume`; approved on a snapshot folder → `/conclave:apply`.
