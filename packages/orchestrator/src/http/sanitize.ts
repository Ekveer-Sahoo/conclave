import type { SessionMessage } from "../session/autonomousCouncil.js";

const MAX_TEXT_LENGTH = 4_000;

// Defense-in-depth redaction of secret-shaped substrings that could end up in a system/report
// message (e.g. a verification command's output). Heuristic, not exhaustive.
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:api[_-]?key|token|secret|password|bearer)\s*[:=]\s*\S+/gi,
];

function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function redactPaths(text: string, paths: string[]): string {
  let out = text;
  for (const path of paths) {
    if (path && path.length > 3) out = out.split(path).join("<path>");
  }
  return out;
}

function clip(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}… [truncated]` : text;
}

/** Path + secret redaction and length cap for any free text headed to a browser. */
export function sanitizeText(text: string, absolutePaths: string[]): string {
  return clip(redactSecrets(redactPaths(text, absolutePaths)));
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

export function toClientMessage(message: SessionMessage, absolutePaths: string[]): ClientMessage {
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
    verdict: activity.verdict,
  };
}

