---
description: Review and settle Conclave contentions that are waiting on a human ruling
argument-hint: <session-id> [<contention-id> uphold|dismiss --reason "<why>"]
---

Arguments: $ARGUMENTS

- With only a session id: run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" arbitrate <id>`. For each pending contention, explain the claim, its severity, each side's position, and any verification evidence, in plain terms. Then ask the user to **uphold** or **dismiss** each one and why. Do not choose for them.
- With a full ruling (`<contention-id> uphold|dismiss --reason "..."`): run `"${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" arbitrate $ARGUMENTS` exactly as given.

After a ruling is recorded, tell the user the session can continue with `/conclave:resume <id>`.
