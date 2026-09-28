import { spawn } from "node:child_process";
import { VerdictSchema, type SeatConfig, type Verdict } from "@conclave/core";

export interface CliInvocation {
  seat: SeatConfig;
  prompt: string;
  cwd: string;
  mode?: "audit" | "execute";
  /** Set only when this invocation is explicitly scoped to verifying one finding. */
  findingId?: string;
  /** Cooperative cancellation: aborting kills the whole child process tree and rejects with CliCancelledError. */
  signal?: AbortSignal;
}

export type CommandVerificationResult = "PASS" | "FAIL" | "DENIED" | "INCONCLUSIVE";
export interface CommandCapture {
  command: string;
  result: CommandVerificationResult;
  exitCode?: number;
  output: string;
  /** Only set when the invocation that produced this capture was explicitly scoped to one finding. */
  findingId?: string;
}

/**
 * Usage normalized from a provider's own outer envelope (never from the model's self-reported
 * verdict.raw_usage, which a model can freely fabricate). `null` at the call site means the
 * envelope carried no parseable, in-range usage — callers must treat that as "unavailable", not zero.
 *
 * Cached-input inclusion in promptTokens is provider-specific:
 * - claude: cachedInputTokens (cache_read_input_tokens) is SEPARATE/ADDITIVE — not part of promptTokens.
 * - codex: cachedInputTokens (cached_input_tokens) is a SUBSET already included in promptTokens
 *   (inferred from OpenAI Responses API usage conventions; not yet observed with a nonzero sample).
 * - antigravity: cachedInputTokens (cache_read_tokens) is a SUBSET already included in promptTokens
 *   (confirmed: total_tokens === input_tokens + output_tokens).
 */
export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
  source: "claude_envelope" | "codex_envelope" | "antigravity_envelope" | "xenia_envelope" | "fake";
}

export interface CliSeatOutcome {
  verdict: Verdict;
  usage: ProviderUsage | null;
  commandRuns: CommandCapture[];
}

const MAX_PLAUSIBLE_TOKENS = 5_000_000;
const MAX_PLAUSIBLE_COST_USD = 100;

function sanitizeTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > MAX_PLAUSIBLE_TOKENS) return undefined;
  return value;
}

function sanitizeCostUsd(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_PLAUSIBLE_COST_USD) return undefined;
  return value;
}

function reverseLines(stdout: string): unknown[] {
  const values: unknown[] = [];
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") values.push(value);
    } catch {
      continue;
    }
  }
  return values;
}

function extractClaudeUsage(stdout: string): ProviderUsage | null {
  for (const value of reverseLines(stdout)) {
    const record = value as Record<string, unknown>;
    if (record.type !== "result") continue;
    const usage = record.usage as Record<string, unknown> | undefined;
    if (!usage) return null;
    const promptTokens = sanitizeTokenCount(usage.input_tokens);
    const completionTokens = sanitizeTokenCount(usage.output_tokens);
    if (promptTokens === undefined || completionTokens === undefined) return null;
    return {
      promptTokens,
      completionTokens,
      cachedInputTokens: sanitizeTokenCount(usage.cache_read_input_tokens),
      costUsd: sanitizeCostUsd(record.total_cost_usd),
      source: "claude_envelope",
    };
  }
  return null;
}

function extractCodexUsage(stdout: string): ProviderUsage | null {
  for (const value of reverseLines(stdout)) {
    const record = value as Record<string, unknown>;
    if (record.type !== "turn.completed") continue;
    const usage = record.usage as Record<string, unknown> | undefined;
    if (!usage) return null;
    const promptTokens = sanitizeTokenCount(usage.input_tokens);
    const completionTokens = sanitizeTokenCount(usage.output_tokens);
    if (promptTokens === undefined || completionTokens === undefined) return null;
    return {
      promptTokens,
      completionTokens,
      cachedInputTokens: sanitizeTokenCount(usage.cached_input_tokens),
      source: "codex_envelope",
    };
  }
  return null;
}

function extractAntigravityUsage(stdout: string): ProviderUsage | null {
  for (const value of reverseLines(stdout)) {
    const record = value as Record<string, unknown>;
    if (record.type) continue;
    const usage = record.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const promptTokens = sanitizeTokenCount(usage.input_tokens);
    const completionTokens = sanitizeTokenCount(usage.output_tokens);
    if (promptTokens === undefined || completionTokens === undefined) return null;
    return {
      promptTokens,
      completionTokens,
      cachedInputTokens: sanitizeTokenCount(usage.cache_read_tokens),
      source: "antigravity_envelope",
    };
  }
  return null;
}

/** Dispatches to the provider-specific usage extractor for a seat, returning null when
 * authoritative usage is absent, malformed, or out of plausible range. */
export function extractProviderUsage(seatId: string, stdout: string): ProviderUsage | null {
  try {
    if (seatId === "claude") return extractClaudeUsage(stdout);
    if (seatId === "codex") return extractCodexUsage(stdout);
    if (seatId === "antigravity") return extractAntigravityUsage(stdout);
    return null;
  } catch {
    return null;
  }
}

export class CliInvocationError extends Error {
  seatId: string;
  commandRuns: CommandCapture[];
  constructor(seatId: string, message: string, commandRuns: CommandCapture[] = []) {
    super(`${seatId}: ${message}`);
    this.seatId = seatId;
    this.commandRuns = commandRuns;
  }
}

/** Thrown instead of CliInvocationError when a seat invocation was cancelled via AbortSignal, so callers can distinguish a deliberate cancellation from a real provider failure. */
export class CliCancelledError extends CliInvocationError {}

/**
 * Kills a child's whole process tree, not just the direct child. Every seat is spawned detached
 * so it leads its own POSIX process group (pgid === child.pid); signalling the negated pid signals
 * that entire group, which also reaches any grandchildren the CLI tool itself spawns (wrapper
 * scripts, npx, etc.) that `child.kill()` alone would silently orphan.
 */
function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // process already exited
    }
  }
}

const FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "seat",
    "role",
    "target",
    "category",
    "severity",
    "description",
    "falsifiable_test",
    "confidence",
  ],
  properties: {
    id: { type: "string" },
    seat: { type: "string" },
    role: {
      enum: [
        "CORRECTNESS",
        "ARCHITECTURE",
        "SECURITY",
        "PERFORMANCE",
        "SPEC_FIDELITY",
        "TESTABILITY",
        "SIMPLICITY",
      ],
    },
    target: { type: "string" },
    category: { type: "string" },
    severity: { enum: ["BLOCKER", "MAJOR", "MINOR", "NIT"] },
    description: { type: "string" },
    falsifiable_test: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

/** Structured-verdict contract shared by every adapter that can ask a provider for JSON. */
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // Everything a model can actually answer, and nothing it can't: self-reported token counts are
  // not asked for (see VerdictSchema.raw_usage). Every property stays required, as OpenAI's strict
  // json_schema mode demands.
  required: ["seat", "findings", "overall_verdict", "verdict_reasoning"],
  properties: {
    seat: { type: "string" },
    findings: { type: "array", items: FINDING_SCHEMA },
    overall_verdict: { enum: ["APPROVE", "APPROVE_WITH_CHANGES", "REJECT"] },
    verdict_reasoning: { type: "string" },
  },
} as const;

const JSON_SCHEMA = JSON.stringify(VERDICT_JSON_SCHEMA);

const CODEX_JSON_INSTRUCTION = `\n\nRespond with ONLY a single raw JSON object as your final message — no markdown code fences, no prose before or after, no explanation. The JSON object must match exactly this JSON Schema:\n${JSON_SCHEMA}`;

/** Single source of truth for the read-only verification commands seats may run. Both the
 * `--allowedTools` permission grant and the command-capture allowlist are derived from this so
 * they cannot drift apart. */
const VERIFICATION_COMMAND_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "ls",
  "pwd",
  "find",
  "rg",
  "node --test",
  "pnpm test",
  "pnpm typecheck",
  "pnpm build",
];

const AUDIT_ALLOWED_BASH = VERIFICATION_COMMAND_PREFIXES.flatMap((prefix) => [`Bash(${prefix})`, `Bash(${prefix} *)`]);

/** Steers seats toward the one command-execution path this environment actually allows
 * (`node --test` against a checked-in test file). Appended to prompts rather than expanding
 * VERIFICATION_COMMAND_PREFIXES — arbitrary inline `node -e` stays denied; this just tells the
 * model what to do instead of leaving it to discover the denial by trial and error. */
const VERIFICATION_GUIDANCE =
  "\n\nWhen verifying behavior, add or use a checked-in test file and run it with `node --test` " +
  "(e.g. `node --test path/to/file.test.js`). Do not run `node -e` or any other inline JavaScript " +
  "one-liner to check behavior — it is not permitted here and will be denied.";

/** Structural (whole-token) prefix match, not substring — "rg" must not match inside "argument". */
function isAllowlistedVerificationCommand(command: string): boolean {
  const trimmed = command.trim();
  return VERIFICATION_COMMAND_PREFIXES.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
}

/**
 * The model and extra flags an operator configured for a CLI seat. Shared with the doctor probe,
 * so `doctor` checks the same model and provider routing a run will actually use.
 */
export function seatCliOptions(seat: SeatConfig): string[] {
  return [...(seat.cliModel ? ["--model", seat.cliModel] : []), ...(seat.cliExtraArgs ?? [])];
}

/**
 * Why a CLI failed, when it said so on stdout rather than stderr — Claude Code in stream-json mode
 * reports errors (e.g. `error_max_structured_output_retries`) only in its final `result` record.
 * Without this, the failure reaches the event log as a bare "exited 1:".
 */
export function resultErrorSummary(stdout: string): string {
  for (const value of reverseLines(stdout)) {
    const record = value as Record<string, unknown>;
    if (record.type !== "result") continue;
    const parts = [record.subtype, record.result, record.error, ...(Array.isArray(record.errors) ? record.errors : [])]
      .filter((part) => typeof part === "string" && part.length > 0) as string[];
    if (parts.length > 0) return parts.join(": ").slice(0, 500);
  }
  const tail = stdout.trim().split(/\r?\n/).slice(-3).join(" ").trim();
  return tail ? tail.slice(-300) : "(no output)";
}

/** Exported for tests: the exact argv a seat invocation spawns. */
export function commandFor(seat: SeatConfig, prompt: string, mode: "audit" | "execute"): { command: string; args: string[] } {
  const command = seat.cliCommand;
  if (!command) throw new CliInvocationError(seat.id, "cliCommand is required");
  if (seat.cliArgsTemplate?.length) {
    return { command, args: seat.cliArgsTemplate.map((arg) => arg.replaceAll("{prompt}", prompt)) };
  }
  const modelArgs = seatCliOptions(seat);
  switch (seat.id) {
    case "claude": {
      // stream-json + --verbose exposes the tool_use/tool_result transcript needed to capture
      // which verification commands actually ran, alongside the same final result envelope
      // (jsonObject already scans NDJSON from the end, so verdict parsing is unaffected).
      // CONCLAVE_DISABLE_STREAM_CAPTURE=1 reverts to the prior plain-json path as a fallback if
      // stream parsing ever proves unreliable against a live Claude Code release.
      const streamCapture = process.env.CONCLAVE_DISABLE_STREAM_CAPTURE !== "1";
      const outputArgs = streamCapture ? ["--output-format", "stream-json", "--verbose"] : ["--output-format", "json"];
      const claudePrompt = `${prompt}${VERIFICATION_GUIDANCE}`;
      return mode === "execute"
        ? { command, args: ["-p", claudePrompt, ...outputArgs, "--json-schema", JSON_SCHEMA, "--permission-mode", "acceptEdits", "--allowedTools", ...AUDIT_ALLOWED_BASH, ...modelArgs] }
        // Audits and votes must be read-only. The permission mode is pinned rather than inherited:
        // an operator's own default (e.g. "auto") would otherwise approve commands outside the
        // allowlist — including in-place edits of the worktree every seat is reading concurrently.
        : { command, args: ["-p", claudePrompt, ...outputArgs, "--json-schema", JSON_SCHEMA, "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep,Bash", "--allowedTools", ...AUDIT_ALLOWED_BASH, ...modelArgs] };
    }
    case "codex":
      return { command, args: ["exec", "--sandbox", "read-only", "--color", "never", "--json", ...modelArgs, `${prompt}${VERIFICATION_GUIDANCE}${CODEX_JSON_INSTRUCTION}`] };
    case "antigravity": {
      // agy's --sandbox denies every command-tool call outright (no fine-grained allowlist like
      // Claude's --allowedTools exists at the CLI level; the only finer control is a permissions.allow
      // rule in the user's global ~/.gemini settings, which Conclave must not mutate as a side effect).
      // A denied command call makes agy return an empty response with no structured_output at all,
      // which previously surfaced as an opaque "invalid verdict" MALFORMED failure. Since the model's
      // decision to reach for a shell command is what triggers the denial, and is nondeterministic
      // across otherwise-identical prompts, telling it up front never to attempt one removes the
      // trigger entirely instead of trying to react to it after the fact.
      const antigravityPrompt = `${prompt}\n\nDo not run any shell, terminal, or command-tool actions in this environment — every command call is denied unconditionally and a denied call returns an empty, unusable response instead of an error you could recover from. Review by reading files only.`;
      return { command, args: ["-p", antigravityPrompt, "--output-format", "json", "--json-schema", JSON_SCHEMA, "--sandbox", "--disable-slash-commands", ...modelArgs] };
    }
    default:
      return { command, args: [...modelArgs, prompt] };
  }
}

/** Thrown when a provider's own envelope reports it was blocked from acting rather than that it
 * produced a badly-shaped answer — callers should classify this as unavailable, not malformed. */
export class ProviderActionDeniedError extends Error {}

export function jsonObject(text: string): { output: unknown; permissionDenials: unknown[] } {
  const lines = text.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue; /* diagnostic or streaming line */
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    const permissionDenials = Array.isArray(record.permission_denials) ? record.permission_denials : [];
    if (record.structured_output) return { output: record.structured_output, permissionDenials };
    if (record.result && typeof record.result === "object") return { output: record.result, permissionDenials };
    if (record.type === "item.completed") {
      const item = record.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") return { output: JSON.parse(item.text), permissionDenials };
    }
    if (record.overall_verdict) return { output: record, permissionDenials };
    if (Array.isArray(record.denied_actions) && record.denied_actions.length > 0) {
      const denied = record.denied_actions
        .map((action) => (action && typeof action === "object" ? ((action as Record<string, unknown>).display_name ?? (action as Record<string, unknown>).action) : action))
        .join(", ");
      throw new ProviderActionDeniedError(`provider denied required action(s) and returned no verdict: ${denied}`);
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return { output: JSON.parse(text.slice(start, end + 1)), permissionDenials: [] };
  throw new Error("provider returned no JSON object");
}

const MAX_CAPTURED_OUTPUT_CHARS = 4000;
const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|token|password|passwd|authorization)\s*[:=]\s*\S+/gi,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
];

function sanitizeOutput(raw: string): string {
  let text = raw;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED]");
  if (text.length > MAX_CAPTURED_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_CAPTURED_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_CAPTURED_OUTPUT_CHARS} chars]`;
  }
  return text;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string" ? ((item as Record<string, unknown>).text as string) : ""))
      .join("\n");
  }
  return "";
}

/** Codex runs each command through a login shell (`bash -lc '<cmd>'`); recover the command itself. */
function unwrapShellCommand(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return match ? match[2] : command;
}

/** A codex `--json` command_execution item, reduced to a capture. Only completed items count. */
function codexCommandCapture(item: Record<string, unknown>): CommandCapture | null {
  if (item.type !== "command_execution" || typeof item.command !== "string") return null;
  const command = unwrapShellCommand(item.command);
  const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
  const exitCode = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : undefined;
  const result: CommandVerificationResult =
    item.status === "declined" ? "DENIED" : exitCode === undefined ? "INCONCLUSIVE" : exitCode === 0 ? "PASS" : "FAIL";
  return { command, result, exitCode, output: result === "DENIED" ? "" : sanitizeOutput(output) };
}

function extractExitCode(output: string): number | undefined {
  const match = output.match(/\bexit(?:ed)? (?:code )?(\d+)\b/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Reconstructs which allowlisted verification commands a seat actually ran from its raw CLI
 * output. Works against claude's `--output-format stream-json` (NDJSON tool_use/tool_result
 * blocks), codex's `--json` event stream (completed `command_execution` items), and plain
 * `--output-format json`/other seats, where only permission-denied commands are recoverable (from
 * `permission_denials`) since no tool transcript is present. Never throws — malformed or
 * unrecognized lines are skipped.
 */
export function parseCommandCaptures(rawStdout: string, permissionDenials: unknown[]): CommandCapture[] {
  const commandsByToolUseId = new Map<string, string>();
  const resultsByToolUseId = new Map<string, { text: string; isError: boolean }>();
  const deniedToolUseIds = new Set<string>();
  const codexCaptures: CommandCapture[] = [];

  for (const denial of permissionDenials) {
    if (!denial || typeof denial !== "object") continue;
    const d = denial as Record<string, unknown>;
    if (d.tool_name !== "Bash") continue;
    const toolUseId = typeof d.tool_use_id === "string" ? d.tool_use_id : undefined;
    const input = d.tool_input && typeof d.tool_input === "object" ? (d.tool_input as Record<string, unknown>) : undefined;
    const command = input && typeof input.command === "string" ? input.command : undefined;
    if (toolUseId && command) {
      deniedToolUseIds.add(toolUseId);
      commandsByToolUseId.set(toolUseId, command);
    }
  }

  for (const line of rawStdout.trim().split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.type === "item.completed" && record.item && typeof record.item === "object") {
      const capture = codexCommandCapture(record.item as Record<string, unknown>);
      if (capture && isAllowlistedVerificationCommand(capture.command)) codexCaptures.push(capture);
      continue;
    }
    const message = record.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
    if (record.type === "assistant") {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const block = item as Record<string, unknown>;
        if (block.type === "tool_use" && block.name === "Bash" && typeof block.id === "string") {
          const input = block.input as Record<string, unknown> | undefined;
          if (input && typeof input.command === "string") commandsByToolUseId.set(block.id, input.command);
        }
      }
    } else if (record.type === "user") {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const block = item as Record<string, unknown>;
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          resultsByToolUseId.set(block.tool_use_id, { text: toolResultText(block.content), isError: block.is_error === true });
        }
      }
    }
  }

  const captures: CommandCapture[] = [...codexCaptures];
  for (const [toolUseId, command] of commandsByToolUseId) {
    if (!isAllowlistedVerificationCommand(command)) continue;
    if (deniedToolUseIds.has(toolUseId)) {
      captures.push({ command, result: "DENIED", output: "" });
      continue;
    }
    const outcome = resultsByToolUseId.get(toolUseId);
    if (!outcome) {
      captures.push({ command, result: "INCONCLUSIVE", output: "" });
      continue;
    }
    captures.push({
      command,
      result: outcome.isError ? "FAIL" : "PASS",
      exitCode: extractExitCode(outcome.text),
      output: sanitizeOutput(outcome.text),
    });
  }
  return captures;
}

export async function invokeCliSeat(input: CliInvocation): Promise<CliSeatOutcome> {
  if (input.seat.adapter !== "cli") throw new CliInvocationError(input.seat.id, "seat is not a CLI adapter");
  const { command, args } = commandFor(input.seat, input.prompt, input.mode ?? "audit");
  const timeoutMs = input.seat.timeoutMs;
  const captures = (stdout: string, permissionDenials: unknown[] = []): CommandCapture[] =>
    parseCommandCaptures(stdout, permissionDenials).map((capture) =>
      input.findingId ? { ...capture, findingId: input.findingId } : capture,
    );
  if (input.signal?.aborted) {
    throw new CliCancelledError(input.seat.id, "cancelled before the process was started");
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      // Detached so this child leads its own process group; see killProcessTree.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    let timedOut = false;
    const killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), timeoutMs + 5_000);
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killProcessTree(child, "SIGTERM");
      setTimeout(() => killProcessTree(child, "SIGKILL"), 5_000).unref();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(new CliInvocationError(input.seat.id, error.message));
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (cancelled) return reject(new CliCancelledError(input.seat.id, "cancelled", captures(stdout)));
      if (timedOut) return reject(new CliInvocationError(input.seat.id, `timed out after ${timeoutMs}ms`, captures(stdout)));
      if (code !== 0) return reject(new CliInvocationError(input.seat.id, `exited ${code ?? signal}: ${stderr.trim() || resultErrorSummary(stdout)}`, captures(stdout)));
      try {
        const { output, permissionDenials } = jsonObject(stdout);
        // A denied command is recorded (as a DENIED capture, which never counts as evidence) but
        // does not void the verdict: the seat still judged the work, and discarding its whole vote
        // — ejecting it from the council — over one command outside the allowlist is far worse.
        const commandRuns = captures(stdout, permissionDenials);
        const verdict = VerdictSchema.parse(output);
        const usage = extractProviderUsage(input.seat.id, stdout);
        resolve({ verdict: { ...verdict, seat: input.seat.id }, usage, commandRuns });
      } catch (error) {
        if (error instanceof ProviderActionDeniedError) {
          return reject(new CliInvocationError(input.seat.id, error.message, captures(stdout)));
        }
        reject(new CliInvocationError(input.seat.id, `invalid verdict: ${String(error)}; stderr: ${stderr.trim()}`, captures(stdout)));
      }
    });
  });
}

export async function invokeCliCouncil(seats: SeatConfig[], prompt: string, cwd: string, signal?: AbortSignal) {
  return await Promise.allSettled(
    seats.filter((seat) => seat.enabled).map((seat) => invokeCliSeat({ seat, prompt, cwd, signal })),
  );
}
