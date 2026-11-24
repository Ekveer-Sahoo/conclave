---
description: Show or change the Conclave council's seats and models
argument-hint: [models <seat> | set <seat> <model> | reset <seat> | test <seat> [<model>] | enable <seat> | disable <seat>]
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" seats $ARGUMENTS` and present the result as a table when it lists seats (seat, adapter, model, enabled).

- `set`, `reset`, `enable`, and `disable` change `~/.conclave/seat-config.json` (or `CONCLAVE_SEAT_CONFIG_PATH`) for every future council: confirm with the user before running them.
- `test` makes a real, billed model call: say so before running it.
- After a change, suggest `/conclave:doctor` to confirm the council is healthy.
