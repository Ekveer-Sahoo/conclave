---
description: Check that the Conclave CLI is installed and every seat's provider is reachable
---

1. Run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" --help`. If it exits 127, the CLI is not installed: relay its install instructions and stop.
2. Tell the user that `doctor` makes one small, real model call per CLI seat, then run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" doctor`.
3. Present each seat as **OK**, **FAIL**, or **MISSING**, with the `fix:` hint for any that are not OK (e.g. `codex login`). Note that disabled seats never fail the check.
