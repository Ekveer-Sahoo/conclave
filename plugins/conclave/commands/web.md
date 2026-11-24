---
description: Start the Conclave web UI (live sessions, rulings, seats) in the background
argument-hint: [port]
---

1. Port: $ARGUMENTS if given, otherwise `4317`.
2. If something already answers on `http://127.0.0.1:<port>/api/usage`, it is already running: just give the user the URL.
3. Otherwise start it **in the background**: `CONCLAVE_PORT=<port> "${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" --web`, wait until the URL answers, and give the user `http://127.0.0.1:<port>`.

The web UI shares the session registry with the CLI, so sessions started either way appear in both.
