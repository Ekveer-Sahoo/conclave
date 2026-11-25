import type { SessionMessage } from "../session/autonomousCouncil.js";
import { redactSecrets } from "../secrets.js";

const MAX_TEXT_LENGTH = 4_000;

/** An absolute path to redact, with the readable label that replaces it. */
export type RedactablePath = string | { path: string; label: string };

/**
 * Replaces absolute paths with a readable label ("[worktree]") rather than an opaque placeholder:
 * the reader still learns *which* location a message refers to, just not where it lives on disk.
 * Longest paths first, so a path that prefixes another cannot split it.
 */
function redactPaths(text: string, paths: RedactablePath[]): string {
  const entries = paths
    .map((entry) => (typeof entry === "string" ? { path: entry, label: "path" } : entry))
    .filter((entry) => entry.path && entry.path.length > 3)
    .sort((a, b) => b.path.length - a.path.length);
  let out = text;
  // The home directory reads naturally as "~"; every other location gets a bracketed label.
  for (const { path, label } of entries) out = out.split(path).join(label === "~" ? "~" : `[${label}]`);
  return out;
}

/**
 * Models sometimes echo the verdict schema's field names as XML-ish tags around their answer
 * ("…</verdict_reasoning>"). They carry no meaning for a reader; drop them.
 */
const SCHEMA_TAG = /<\/?(?:verdict_reasoning|overall_verdict|findings|seat|raw_usage)>/g;

function clip(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}… [truncated]` : text;
}

/** Path + secret redaction and length cap for any free text headed to a browser. */
export function sanitizeText(text: string, absolutePaths: RedactablePath[]): string {
  return clip(redactSecrets(redactPaths(text, absolutePaths)).replace(SCHEMA_TAG, "").trim());
}

/**
 * Client-facing view of a durable session message. Strips filesystem paths outside the selected
 * repository and secret-shaped substrings, and caps text length — this is the only shape ever
 * sent over SSE or the messages API; nothing else in the durable event log reaches the browser.
 */
export interface ClientMessage {
  seq: number;
  ts: string;
  kind: "user" | "activity";
  text: string;
  activityKind?: "phase" | "seat" | "system" | "report";
  seat?: string;
  phase?: string;
  round?: number;
  verdict?: unknown;
}

/**
 * A seat's verdict as the browser may see it: its call and its findings, every text field redacted
 * and capped like any other message. `verdict_reasoning` is the message text itself, already sent.
 */
function clientVerdict(verdict: unknown, absolutePaths: RedactablePath[]): unknown {
  if (!verdict || typeof verdict !== "object") return undefined;
  const { overall_verdict, findings } = verdict as { overall_verdict?: unknown; findings?: unknown };
  const text = (value: unknown) => (typeof value === "string" ? sanitizeText(value, absolutePaths) : value);
  return {
    overall_verdict,
    findings: Array.isArray(findings)
      ? findings.map((finding) => {
          if (!finding || typeof finding !== "object") return finding;
          const f = finding as Record<string, unknown>;
          return {
            id: text(f.id),
            seat: text(f.seat),
            role: f.role,
            severity: f.severity,
            confidence: f.confidence,
            category: text(f.category),
            target: text(f.target),
            description: text(f.description),
            falsifiable_test: text(f.falsifiable_test),
          };
        })
      : [],
  };
}

export function toClientMessage(message: SessionMessage, absolutePaths: RedactablePath[]): ClientMessage {
  if (message.kind === "user") {
    return { seq: message.seq, ts: message.ts, kind: "user", text: sanitizeText(message.text, absolutePaths) };
  }
  const { activity } = message;
  return {
    seq: message.seq,
    ts: message.ts,
    kind: "activity",
    text: sanitizeText(activity.message, absolutePaths),
    activityKind: activity.kind,
    seat: activity.seat,
    phase: activity.phase,
    round: activity.round,
    verdict: clientVerdict(activity.verdict, absolutePaths),
  };
}

