/**
 * Secret-shaped substrings, redacted from anything that leaves the event log for a browser or an
 * error message (command output, a CLI's stderr, model text). Heuristic, not exhaustive — defense
 * in depth, never the only protection.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "$R"],
  [/AKIA[0-9A-Z]{16}/g, "$R"],
  [/(?<![A-Za-z0-9])(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "$R"],
  [/(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "$R"],
  [/(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g, "$R"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "$R"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer $R"],
  // KEY=value, KEY: value, "key": "value" — including prefixed names (OPENAI_API_KEY,
  // AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN). The name stays readable; a bare number (a token count)
  // is not a secret.
  [
    /([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|authorization)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*["']?)(?!\d+\b)([^\s"',;}]+)/gi,
    "$1$2$R",
  ],
];

export function redactSecrets(text: string, replacement = "[redacted]"): string {
  let out = text;
  for (const [pattern, template] of PATTERNS) out = out.replace(pattern, template.replaceAll("$R", replacement));
  return out;
}
