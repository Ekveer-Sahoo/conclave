---
description: Convene a Conclave council on a task in the current repository
argument-hint: "<task>" [--budget <usd>] [--model <seat>=<model>] [--allow-dirty-source]
---

Start a Conclave council session for this task:

$ARGUMENTS

Steps:

1. If `$ARGUMENTS` is empty, ask the user what the council should work on and stop.
2. Separate the task text from any flags (`--budget`, `--model`, `--cwd`, `--allow-dirty-source`). Default `--cwd` to the current working directory. Unless the user gave `--budget`, pass none (the CLI default is $20) and say so.
3. If `git status --porcelain` shows uncommitted changes and the user did not pass `--allow-dirty-source`, tell them the council works from the last commit and ask whether to commit first or run anyway.
4. Run it **in the background** (a council takes minutes to hours):

   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/conclave-cli" run "<task>" --cwd "<repo>" [flags]
   ```

   The session id is printed to stderr right away. Read it from the output and tell the user, along with how to follow it: `/conclave:status <id>` or `/conclave:web`.
5. When the background run finishes, interpret the exit code: `0` ratified, `1` the council concluded without ratifying (run `/conclave:status <id>` and explain the outcome and reason), `2` the command was refused (show the error).
6. If the outcome is `awaiting_human`, point the user to `/conclave:arbitrate <id>`. If the folder was not a git repository and the work was ratified, point them to `/conclave:apply <id>`.
