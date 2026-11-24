---
description: List Conclave sessions in this repository, most recent first
argument-hint: [--limit <n>] [--db <path>]
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" list $ARGUMENTS` from the current repository and present the sessions as a compact table (id, state, task, started). If there are none, say so and suggest `/conclave:run`.
