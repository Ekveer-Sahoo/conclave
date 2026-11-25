// Conclave browser UI. Vanilla JS, no build step, no dependencies.
//
// Every string that comes from the server (task text, model output, seat labels, error messages)
// is untrusted. It is escaped with escapeHtml(), either directly or by the markdown renderer (which
// escapes first and only then adds markup of its own), or it is assigned with textContent. Class
// names and tones come only from fixed allowlists, and the only inline style values are numbers
// computed in this file.

// ---------------------------------------------------------------------------------------------
// Constants

const PAGE_SIZE = 20; // sessions per "Load more"
const MAX_SESSION_REQUEST = 100; // server cap for /api/sessions?limit=
const MESSAGE_PAGE = 200; // server cap for /messages?limit=; it counts messages, so a short page is the end
const SESSION_POLL_MS = 10_000;
const USAGE_POLL_MS = 30_000;
const DETAIL_DEBOUNCE_MS = 800;
const RECONNECT_MS = 5_000;
const TOAST_MS = 3_500;
const NOTICE_MS = 12_000;

const PHASE_NAMES = {
  INTAKE: "Intake",
  PLAN: "Plan",
  PLAN_AUDIT: "Plan audit",
  PLAN_REFINE: "Plan revision",
  DELIBERATE: "Deliberation",
  RATIFY_PLAN: "Plan vote",
  EXECUTE: "Execution",
  WORK_AUDIT: "Work audit",
  WORK_REFINE: "Work deliberation",
  REMEDIATE: "Remediation",
  RE_AUDIT: "Re-audit",
  RATIFY_WORK: "Work vote",
  REPORT: "Report",
};
const PHASE_TOKEN = new RegExp(`\\b(${Object.keys(PHASE_NAMES).sort((a, b) => b.length - a.length).join("|")})\\b`, "g");

/** Phases where only the executor (Claude) speaks: its verdict is a formality, not a judgement. */
const EXECUTOR_PHASES = new Set(["PLAN", "PLAN_REFINE", "EXECUTE", "REMEDIATE"]);
/** Phases where every active seat is asked for a verdict. */
const FANOUT_PHASES = new Set(["PLAN_AUDIT", "WORK_AUDIT", "RE_AUDIT", "RATIFY_PLAN", "RATIFY_WORK"]);
const DELIBERATION_PHASES = new Set(["DELIBERATE", "WORK_REFINE"]);
const VOTE_PHASES = ["RATIFY_PLAN", "RATIFY_WORK"];
const EXECUTOR_SUMMARY = { PLAN: "drafted the plan", PLAN_REFINE: "revised the plan", EXECUTE: "implemented the plan", REMEDIATE: "addressed the objections" };
const SUBJECT = { PLAN_AUDIT: "plan", RATIFY_PLAN: "plan vote", WORK_AUDIT: "work", RE_AUDIT: "work", RATIFY_WORK: "work vote" };

const STEPS = [
  { label: "Plan", phases: ["INTAKE", "PLAN", "PLAN_REFINE"] },
  { label: "Audit", phases: ["PLAN_AUDIT", "DELIBERATE"] },
  { label: "Vote", phases: ["RATIFY_PLAN"] },
  { label: "Execute", phases: ["EXECUTE"] },
  { label: "Audit", phases: ["WORK_AUDIT", "WORK_REFINE", "REMEDIATE", "RE_AUDIT"] },
  { label: "Vote", phases: ["RATIFY_WORK"] },
  { label: "Report", phases: ["REPORT"] },
];

const SEVERITIES = ["BLOCKER", "MAJOR", "MINOR", "NIT"];
const SEVERITY_TONE = { BLOCKER: "danger", MAJOR: "warning", MINOR: "neutral", NIT: "neutral" };
const VERDICTS = {
  APPROVE: { label: "Approve", tone: "success" },
  APPROVE_WITH_CHANGES: { label: "Approve with changes", tone: "warning" },
  REJECT: { label: "Reject", tone: "danger" },
};
const STATES = {
  running: { label: "Running", tone: "info", glyph: "●" },
  orphaned: { label: "Interrupted", tone: "warning", glyph: "▲" },
  approved: { label: "Ratified", tone: "success", glyph: "✓" },
  not_approved: { label: "Not ratified", tone: "danger", glyph: "✕" },
  awaiting_human: { label: "Needs ruling", tone: "attention", glyph: "⚑" },
  cancelled: { label: "Stopped", tone: "neutral", glyph: "■" },
  errored: { label: "Failed", tone: "danger", glyph: "✕" },
};
const STANCES = {
  DISSENT: "objects",
  REJECT: "disagrees",
  ACCEPT: "agrees",
  CLARIFY: "asks for clarification",
  COUNTER: "counters",
  WITHDRAW: "withdraws",
  HOLD: "holds",
  AMEND: "amends",
  SPLIT: "splits the claim",
  CO_SIGN: "co-signs",
  SYNTHESIS: "synthesises",
};
const TONES = new Set(["success", "warning", "danger", "attention", "info", "neutral"]);
const TABS = ["overview", "timeline", "findings", "disputes"];
const SEAT_HUES = [45, 250, 165, 330, 95, 205];
const KNOWN_INITIALS = { claude: "Cl", codex: "Cx", antigravity: "Ag" };

const CHEVRON = `<svg class="chev" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------------------------------------
// Elements and state

const $ = (id) => document.getElementById(id);
const els = {
  meter5h: $("meter-5h"),
  meterWeek: $("meter-week"),
  runSummary: $("run-summary"),
  conn: $("conn"),
  connText: $("conn-text"),
  newCouncil: $("new-council"),
  newCouncilTip: $("new-council-tip"),
  openSettings: $("open-settings"),
  settingsDot: $("settings-dot"),
  sessionCount: $("session-count"),
  toggleSessions: $("toggle-sessions"),
  sessionGroups: $("session-groups"),
  sessionsError: $("sessions-error"),
  sessionListBody: $("session-list-body"),
  loadMore: $("load-more"),
  sessionPanel: $("session-panel"),
  welcome: $("welcome"),
  welcomeNew: $("welcome-new"),
  welcomeBusy: $("welcome-busy"),
  view: $("session-view"),
  header: $("session-header"),
  notice: $("notice"),
  strip: $("seat-strip"),
  tabsBar: $("tabs"),
  tabs: { overview: $("tab-overview"), timeline: $("tab-timeline"), findings: $("tab-findings"), disputes: $("tab-disputes") },
  panels: { overview: $("panel-overview"), timeline: $("panel-timeline"), findings: $("panel-findings"), disputes: $("panel-disputes") },
  countFindings: $("count-findings"),
  countDisputes: $("count-disputes"),
  jump: $("jump-latest"),
  railBody: $("rail-body"),
  railCount: $("rail-count"),
  ncDialog: $("new-council-dialog"),
  ncForm: $("new-council-form"),
  ncTask: $("nc-task"),
  ncCwd: $("nc-cwd"),
  ncBusy: $("nc-busy"),
  ncError: $("nc-error"),
  ncSubmit: $("nc-submit"),
  ncHint: $("nc-hint"),
  ncModelsBody: $("nc-models-body"),
  ncNote: $("nc-note"),
  ncBrowse: $("nc-browse"),
  ncBrowser: $("nc-browser"),
  ncFbPath: $("nc-fb-path"),
  ncFbList: $("nc-fb-list"),
  ncFbHint: $("nc-fb-hint"),
  ncFbUse: $("nc-fb-use"),
  ncRecent: $("nc-recent"),
  ncRepoStatus: $("nc-repo-status"),
  ncDirtyWrap: $("nc-dirty-wrap"),
  ncDirty: $("nc-dirty"),
  ncModelsSummary: $("nc-models-summary"),
  stDialog: $("settings-dialog"),
  stBody: $("settings-body"),
  stStatus: $("settings-status"),
  stSave: $("settings-save"),
  toast: $("toast"),
  live: $("live"),
};

const state = {
  // Model catalogs per seat (shared by settings and New council), and this council's overrides
  catalogs: new Map(),
  councilModels: new Map(),
  // Repository picker: the folder browser's current listing, and the last inspected repository
  browser: null,
  repo: null,
  // Applying a ratified plain-folder session: the previewed file list, or the conflict that stopped it
  applyPreview: null,
  applyError: null,
  // Session list
  sessions: [],
  sessionPages: 1,
  hasMore: false,
  sessionsInFlight: null,
  sessionsAgain: false,
  apiDown: false,
  listOpen: true,
  // Selected session
  selectedId: null,
  token: 0,
  session: null,
  sessionJson: "",
  sessionError: null,
  messages: [],
  lastSeq: 0,
  initialLoaded: false,
  liveSeqs: new Set(),
  eventSource: null,
  conn: "idle",
  reconnectTimer: null,
  detailTimer: null,
  timelineFrame: 0,
  catchingUp: false,
  tab: "overview",
  seatFilter: null,
  taskOpen: false,
  confirmStop: false,
  confirmAt: 0,
  stopRequested: false,
  cardOpen: new Map(),
  expandedMsgs: new Set(),
  detailsOpen: new Map(),
  rulingDrafts: new Map(),
  // Council configuration
  seatConfig: null,
  auth: new Map(),
  authCheckedAt: null,
  authStale: false,
  authLoading: false,
  authError: null,
  settings: null,
  busy: false,
  dialogReturn: new Map(),
};

let noticeTimer = null;
let toastTimer = null;

// ---------------------------------------------------------------------------------------------
// Utilities

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const esc = escapeHtml;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const init = { ...options, headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) } };
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, "The Conclave server is unreachable.");
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = (data && typeof data.error === "string" && data.error) || text.trim() || `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message);
  }
  return data;
}

const postJson = (path, payload) => api(path, { method: "POST", body: JSON.stringify(payload ?? {}) });
const sessionPath = (id, suffix = "") => `/api/sessions/${encodeURIComponent(id)}${suffix}`;

function capitalize(text) {
  const s = String(text ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function times(n) {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function joinWords(list) {
  const items = list.filter(Boolean);
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function usd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Server text sometimes carries 4-decimal money; money is always shown with 2. */
function tidyMoney(text) {
  return String(text ?? "").replace(/\$(\d+\.\d{3,})/g, (_, n) => `$${Number(n).toFixed(2)}`);
}

function humanPhase(phase) {
  if (!phase) return "";
  return PHASE_NAMES[phase] ?? capitalize(String(phase).replaceAll("_", " ").toLowerCase());
}

function humanizePhases(text) {
  return String(text ?? "").replace(PHASE_TOKEN, (token) => PHASE_NAMES[token] ?? token);
}

/** "1 seat(s)" -> "1 seat", "14 day(s)" -> "14 days". */
function tidyPlurals(text) {
  return String(text ?? "").replace(/\b(\d+) ((?:[a-z-]+ ){0,2}[a-z-]+)\(s\)/gi, (_, n, words) => `${n} ${Number(n) === 1 ? words : `${words}s`}`);
}

function tidy(text) {
  return tidyPlurals(tidyMoney(humanizePhases(text)));
}

function humanRole(role) {
  return capitalize(String(role ?? "").replaceAll("_", " ").toLowerCase());
}

function roundLabel(round) {
  return Number.isInteger(round) ? `round ${round + 1}` : "";
}

function phaseRound(phase, round) {
  return [humanPhase(phase), roundLabel(round)].filter(Boolean).join(", ");
}

/** "Error: codex: provider dropped" -> "provider dropped", when the seat id is known. */
function stripError(text, seatId) {
  let out = String(text ?? "")
    .replace(/^(?:[A-Za-z]*Error:\s*)+/, "")
    .replace(/\bsession [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "this session");
  if (seatId) out = out.replace(new RegExp(`^${seatId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`), "");
  return out;
}

function toDate(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayDiff(date, now = new Date()) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** "Today 15:31", "Yesterday 09:12", "Mon 21 Sep 15:31". */
function whenLabel(ts) {
  const date = toDate(ts);
  if (!date) return "";
  const days = dayDiff(date);
  if (days === 0) return `Today ${clock(date)}`;
  if (days === 1) return `Yesterday ${clock(date)}`;
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const day = date.toLocaleDateString([], { weekday: days < 7 ? "short" : undefined, day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
  return `${day} ${clock(date)}`;
}

/** "just now", "57 min ago", "3 h ago", "yesterday", "21 Sep". */
function relTime(ts) {
  const date = toDate(ts);
  if (!date) return "";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86_400 && dayDiff(date) === 0) return `${Math.round(seconds / 3600)} h ago`;
  const days = dayDiff(date);
  if (days === 1) return "yesterday";
  if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
  return date.toLocaleDateString([], { day: "numeric", month: "short", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function timeTag(ts, label) {
  const date = toDate(ts);
  if (!date) return "";
  return `<time datetime="${esc(date.toISOString())}" title="${esc(date.toLocaleString())}">${esc(label ?? clock(date))}</time>`;
}

const toneClass = (tone) => `tone-${TONES.has(tone) ? tone : "neutral"}`;
const pill = (label, tone) => `<span class="pill ${toneClass(tone)}">${esc(label)}</span>`;
const badge = (label, tone) => `<span class="badge ${toneClass(tone)}">${esc(label)}</span>`;

function severityBadge(severity) {
  const known = SEVERITIES.includes(severity);
  return badge(known ? capitalize(severity.toLowerCase()) : String(severity ?? "Unknown"), known ? SEVERITY_TONE[severity] : "neutral");
}

function severityRank(severity) {
  const index = SEVERITIES.indexOf(severity);
  return index < 0 ? SEVERITIES.length : index;
}

function stateInfo(sessionState, pending = 0) {
  const base = STATES[sessionState] ?? { label: capitalize(String(sessionState ?? "unknown").replaceAll("_", " ")), tone: "neutral", glyph: "•" };
  if (sessionState === "awaiting_human") {
    if (!(pending > 0)) return { ...base, label: "Ready to resume" };
    if (pending > 1) return { ...base, label: `Needs ${pending} rulings` };
  }
  return base;
}

const sep = `<span class="sep" aria-hidden="true">·</span>`;
const joinMeta = (items) => items.filter(Boolean).join(` ${sep} `);

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, blocked): purely a convenience.
  }
}

/**
 * Re-renders a container without losing keyboard focus or a half-typed value: the focused control
 * is found again by id afterwards and gets its value and caret back.
 */
function preserveFocus(container, render) {
  const active = document.activeElement;
  const id = active && active !== document.body && container.contains(active) ? active.id : "";
  const typed = id && (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && active.type === "text"));
  const value = typed ? active.value : null;
  const selection = typed ? [active.selectionStart, active.selectionEnd] : null;
  render();
  if (!id) return;
  const next = document.getElementById(id);
  if (!next || next.hidden) return;
  if (typed && value !== null) next.value = value;
  next.focus({ preventScroll: true });
  if (selection) {
    try {
      next.setSelectionRange(selection[0], selection[1]);
    } catch {
      // not a text control any more
    }
  }
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

const isNarrow = () => window.matchMedia?.("(max-width: 760px)").matches ?? false;

let announceTimer = null;
function announce(text) {
  clearTimeout(announceTimer);
  els.live.textContent = "";
  // A fresh text node after a clear is what makes screen readers announce a repeat. A timer, not
  // requestAnimationFrame, so an announcement is never held back while the tab is in the background.
  announceTimer = setTimeout(() => {
    els.live.textContent = text;
  }, 60);
}

function showToast(text) {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => (els.toast.hidden = true), TOAST_MS);
}

function showNotice(text, tone = "neutral", { sticky = tone === "danger" } = {}) {
  clearTimeout(noticeTimer);
  els.notice.textContent = text;
  els.notice.className = `notice ${toneClass(tone)}`;
  els.notice.hidden = !text;
  if (text && !sticky) noticeTimer = setTimeout(() => (els.notice.hidden = true), NOTICE_MS);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  els.notice.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Seats: fixed colours by seat order, and initials that never collide

const seatBook = new Map();
const usedInitials = new Set();

function initialsFor(id) {
  const letters = String(id ?? "").replace(/[^A-Za-z0-9]/g, "");
  const first = (letters[0] ?? "?").toUpperCase();
  const candidates = [];
  if (KNOWN_INITIALS[id]) candidates.push(KNOWN_INITIALS[id]);
  const words = String(id ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length > 1) candidates.push(words[0][0].toUpperCase() + words[1][0].toLowerCase());
  for (const ch of letters.slice(1).toLowerCase()) candidates.push(first + ch);
  for (let n = 2; n < 100; n++) candidates.push(`${first}${n}`);
  return candidates.find((candidate) => !usedInitials.has(candidate)) ?? first;
}

function registerSeat(id, label) {
  if (!id) return null;
  const existing = seatBook.get(id);
  if (existing) {
    if (label && existing.label === id) existing.label = label;
    return existing;
  }
  const initials = initialsFor(id);
  usedInitials.add(initials);
  const entry = { id, label: label || id, hue: SEAT_HUES[seatBook.size % SEAT_HUES.length], initials };
  seatBook.set(id, entry);
  return entry;
}

function nameOf(id) {
  if (!id) return "Unknown seat";
  if (/^human\b/i.test(id)) return "You";
  const fromSession = state.session?.seats?.find((seat) => seat.id === id)?.label;
  return fromSession || seatBook.get(id)?.label || id;
}

function seatAttrs(id) {
  const entry = seatBook.get(id);
  return entry ? { cls: "", style: ` style="--h:${Number(entry.hue)}"` } : { cls: " is-neutral", style: "" };
}

function dotHtml(id) {
  const entry = seatBook.get(id);
  const { cls, style } = seatAttrs(id);
  const initials = entry?.initials ?? (/^human\b/i.test(id ?? "") ? "Y" : String(id ?? "?").slice(0, 2));
  return `<span class="dot${cls}"${style} aria-hidden="true">${esc(initials)}</span>`;
}

function seatNameHtml(id) {
  const { cls, style } = seatAttrs(id);
  return `<span class="seat-name${cls}"${style}>${esc(nameOf(id))}</span>`;
}

/** "antigravity, claude" -> "Antigravity CLI and Claude Code". */
function namesFromList(list) {
  return joinWords(String(list ?? "").split(/,\s*/).filter(Boolean).map(nameOf));
}

const ownerOf = (findingId) => String(findingId ?? "").split(":")[0];

// ---------------------------------------------------------------------------------------------
// Markdown: a small, safe subset. Everything is escaped before any markup is added.

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, "    ").length;

function stripIndent(line, count) {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < count && (line[index] === " " || line[index] === "\t")) {
    removed += line[index] === "\t" ? 4 : 1;
    index += 1;
  }
  return line.slice(index);
}

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || /^\s{0,3}>/.test(line) || RULE.test(line);
}

function renderInline(text) {
  const source = String(text ?? "");
  let out = "";
  let last = 0;
  const code = /(`+)([\s\S]*?[^`])\1(?!`)/g;
  let match;
  while ((match = code.exec(source))) {
    out += formatText(source.slice(last, match.index));
    out += `<code>${esc(match[2].trim() || match[2])}</code>`;
    last = match.index + match[0].length;
  }
  return out + formatText(source.slice(last));
}

function formatText(text) {
  return esc(text)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, "$1<em>$2</em>");
}

function renderMarkdown(text) {
  return renderBlocks(String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
}

function renderBlocks(lines) {
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    let match;
    if ((match = FENCE.exec(line))) {
      const indent = indentOf(match[1]);
      const fence = match[2];
      const body = [];
      i += 1;
      while (i < lines.length) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) break;
        body.push(stripIndent(lines[i], indent));
        i += 1;
      }
      i += 1; // closing fence (or end of text)
      out += `<pre><code>${esc(body.join("\n"))}</code></pre>`;
      continue;
    }
    if ((match = HEADING.exec(line))) {
      const tag = match[1].length <= 2 ? "h4" : "h5";
      out += `<${tag} class="md-h">${renderInline(match[2])}</${tag}>`;
      i += 1;
      continue;
    }
    if (RULE.test(line) && !LIST_ITEM.test(line.replace(/\s/g, ""))) {
      out += "<hr>";
      i += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [html, next] = renderList(lines, i);
      out += html;
      i = next;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out += `<blockquote>${renderBlocks(quoted)}</blockquote>`;
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !(paragraph.length && isBlockStart(lines[i]))) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    out += `<p>${paragraph.map(renderInline).join("<br>")}</p>`;
  }
  return out;
}

function renderList(lines, start) {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const match = LIST_ITEM.exec(lines[i]);
    if (!match || indentOf(match[1]) !== baseIndent || /\d/.test(match[2]) !== ordered) break;
    const contentIndent = baseIndent + match[2].length + 1;
    const itemLines = [match[3]];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j < lines.length && indentOf(lines[j]) > baseIndent) {
          for (let k = i; k < j; k += 1) itemLines.push("");
          i = j;
          continue;
        }
        break;
      }
      const indent = indentOf(line);
      if (indent > baseIndent) {
        itemLines.push(stripIndent(line, Math.min(indent, contentIndent)));
        i += 1;
        continue;
      }
      if (!isBlockStart(line)) {
        itemLines.push(line.trim()); // lazy continuation of the item's text
        i += 1;
        continue;
      }
      break;
    }
    items.push(itemLines);
  }
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNumber !== 1 && Number.isFinite(startNumber) ? ` start="${startNumber}"` : "";
  const body = items
    .map((itemLines) => {
      const inner = renderBlocks(itemLines);
      const single = /^<p>([\s\S]*)<\/p>$/.exec(inner);
      return `<li>${single && !single[1].includes("<p>") ? single[1] : inner}</li>`;
    })
    .join("");
  return [`<${tag}${startAttr}>${body}</${tag}>`, i];
}

// ---------------------------------------------------------------------------------------------
// Plain-language rewrites of the council's system lines

const code = (text) => `<code>${esc(text)}</code>`;

/**
 * Turns a system line into a plain sentence where the data allows it. Returns escaped HTML, a tone,
 * and whether it is a marker between phases (a resume, a human ruling) rather than a line in one.
 */
function describeSystem(text, message = {}) {
  const t = String(text ?? "");
  let m;
  const line = (html, tone = "neutral") => ({ html, tone, marker: false });
  const marker = (html, tone = "neutral") => ({ html, tone, marker: true });

  if (/^Intake: /.test(t)) return { hidden: true };
  if ((m = /^Session opened\. Consensus requires every available seat, with a minimum quorum of (\d+)\.$/.exec(t))) {
    return line(`Session opened. Every available seat must approve, and at least ${esc(m[1])} must take part.`);
  }
  if ((m = /^Isolated worktree created at .+? on branch (\S+?)\. /.exec(t))) {
    return line(`Working on branch ${code(m[1])} in an isolated worktree. Your checkout is never touched.`);
  }
  if ((m = /^Contention opened on ([\s\S]+) \((BLOCKER|MAJOR|MINOR|NIT)\): (.+?) objects?; (.+?) do(?:es)? not\.$/.exec(t))) {
    const dissent = String(m[4]).split(/,\s*/).filter(Boolean);
    return line(`${esc(namesFromList(m[3]))} raised a ${esc(m[2].toLowerCase())} on ${code(m[1])}; ${esc(namesFromList(m[4]))} ${dissent.length === 1 ? "disagrees" : "disagree"}.`, "warning");
  }
  if ((m = /^Arbitration on ([\s\S]+?): (UPHELD|DISMISSED|DEFERRED) — ([\s\S]*)$/.exec(t))) {
    const [, target, ruling, reason] = m;
    if (/^Settled by a human arbiter/.test(reason)) return line(`Applied your ruling on ${code(target)}.`, "attention");
    if (ruling === "UPHELD") {
      return line(/executed evidence/.test(reason) ? `Upheld the objection on ${code(target)}: the test reproduced it.` : `Upheld the objection on ${code(target)} by weighted policy.`, "warning");
    }
    if (ruling === "DISMISSED") {
      return line(/executed evidence/.test(reason) ? `Dismissed the objection on ${code(target)}: the test did not reproduce it.` : `Dismissed the objection on ${code(target)} by weighted policy.`);
    }
    if (/human arbitration/.test(reason)) return line(`Too close to call on a blocker, so ${code(target)} goes to you.`, "attention");
    return line(`Deferred ${code(target)} to a later round: the evidence was inconclusive.`);
  }
  if ((m = /^Escalated \S+ \(([\s\S]+?)\) to human arbitration\./.exec(t))) {
    return line(`Escalated ${code(m[1])} to you for a ruling.`, "attention");
  }
  if ((m = /^Falsifiable test for (\S+) (reproduced the claim|did not reproduce the claim|was inconclusive) \(run by (\S+)\)\.$/.exec(t))) {
    const outcome = { "reproduced the claim": "it reproduced", "did not reproduce the claim": "it did not reproduce", "was inconclusive": "it was inconclusive" }[m[2]];
    return line(`${esc(nameOf(m[3]))} ran the test for ${esc(nameOf(ownerOf(m[1])))}’s claim: ${esc(outcome)}.`, m[2] === "reproduced the claim" ? "warning" : "neutral");
  }
  if ((m = /^(Plan|Work) vote: ([\s\S]+)$/.exec(t))) return line(...describeVote(m[1], m[2], message));
  if (/^No seat filed a material finding/.test(t)) {
    return line("No seat filed a material finding, but not every seat approved, so the work continues.", "warning");
  }
  if ((m = /^No disinterested seat able to execute commands is available to run the falsifiable test for (\S+);/.exec(t))) {
    return line(`No neutral seat could run the test for ${esc(nameOf(ownerOf(m[1])))}’s claim, so policy decides.`);
  }
  if ((m = /^Verification of (\S+) by (\S+) failed: ([\s\S]+)$/.exec(t))) {
    return line(`${esc(nameOf(m[2]))} couldn’t run the test for ${esc(nameOf(ownerOf(m[1])))}’s claim: ${esc(stripError(m[3], m[2]))}`, "danger");
  }
  if ((m = /^budget ceiling exceeded: spent \$([\d.]+) of \$([\d.]+)$/.exec(t))) {
    return line(`Budget ceiling reached: spent ${esc(usd(m[1]))} of ${esc(usd(m[2]))}.`, "danger");
  }
  if ((m = /^Resuming session \S+ at (\w+) round (\d+)(, acting on the upheld ruling\(s\) with one more round granted)?\.$/.exec(t))) {
    return marker(`Resumed at ${esc(humanPhase(m[1]))}, round ${esc(m[2])}${m[3] ? ", with one more round for the upheld ruling" : ""}`);
  }
  if ((m = /^Resume failed: ([\s\S]+)$/.exec(t))) return marker(`Resume failed: ${esc(tidy(stripError(m[1])))}`, "danger");
  if ((m = /^Human arbiter (.+?) (upheld|dismissed) the contention on ([\s\S]+?): ([\s\S]+)$/.exec(t))) {
    const who = /^human\b/i.test(m[1]) ? "You" : m[1];
    return marker(`${esc(who)} ${esc(m[2])} the objection on ${code(m[3])}: “${esc(m[4])}”`, "attention");
  }
  return { html: esc(tidy(t)), tone: /failed|error/i.test(t) ? "danger" : "neutral", marker: !message.phase };
}

function describeVote(kind, rest, message) {
  let m;
  if ((m = /^ratified unanimously by (\d+) active seat\(s\)$/.exec(rest))) {
    return [Number(m[1]) === 1 ? "Ratified by the only active seat." : `Ratified by all ${esc(m[1])} seats.`, "success"];
  }
  if ((m = /^ratified: (\d+) approve, (\d+) approve-with-changes/.exec(rest))) {
    return [`Ratified: ${esc(m[1])} approve, ${esc(m[2])} approve with changes.`, "success"];
  }
  if ((m = /^(\d+) seat\(s\) voted REJECT$/.exec(rest))) return [`Not ratified: ${esc(plural(Number(m[1]), "seat"))} rejected.`, "danger"];
  if ((m = /^(\d+) active seat\(s\) did not vote/.exec(rest))) {
    const missing = (state.session?.seats ?? [])
      .filter((seat) => (seat.failures ?? []).some((f) => f.phase === message.phase && f.round === message.round))
      .map((seat) => nameOf(seat.id));
    const who = missing.length ? joinWords(missing) : plural(Number(m[1]), "seat");
    return [`Not ratified: ${esc(who)} didn’t vote, and a missing vote never counts as approval.`, "danger"];
  }
  if ((m = /^quorum not met: (\d+) of (\d+) required votes cast$/.exec(rest))) return [`Not ratified: only ${esc(m[1])} of the ${esc(m[2])} required votes came in.`, "danger"];
  if ((m = /^(\d+) material contention\(s\) still open$/.exec(rest))) return [`Not ratified: ${esc(plural(Number(m[1]), "material dispute"))} still open.`, "danger"];
  if ((m = /^(\d+) conditional approval\(s\) with (\d+) contention\(s\) still open$/.exec(rest))) {
    return [`Not ratified: ${esc(plural(Number(m[1]), "conditional approval"))} while ${esc(plural(Number(m[2]), "dispute"))} ${Number(m[2]) === 1 ? "is" : "are"} still open.`, "danger"];
  }
  return [`${esc(kind)} vote: ${esc(capitalize(tidy(rest)))}`, /^ratified/.test(rest) ? "success" : "danger"];
}

/** The policy's reasoning for an escalation, in words a person can act on. */
function explainPolicy(reasoning) {
  const t = String(reasoning ?? "");
  const weights = /claim ([\d.]+) \((.*?)\) vs dissent ([\d.]+) \((.*?)\)/.exec(t);
  if (weights && /^Inconclusive on a BLOCKER/.test(t)) {
    return `Too close to call. ${esc(namesFromList(weights[2]))}’s claim weighs ${esc(weights[1])} against ${esc(weights[3])} of dissent from ${esc(namesFromList(weights[4]))}. A blocker is never dismissed on a close call, so it comes to you.`;
  }
  if (weights && /^Dissent outweighs the claim/.test(t)) {
    return `Dissent from ${esc(namesFromList(weights[4]))} (${esc(weights[3])}) outweighs ${esc(namesFromList(weights[2]))}’s claim (${esc(weights[1])}), but a blocker is never dismissed automatically, so it comes to you.`;
  }
  return esc(capitalize(tidy(t)));
}

function explainThreadReason(entry) {
  const m = /^(\S+) does not consider ([\s\S]+) material\.$/.exec(String(entry.reasoning ?? ""));
  if (m && m[1] === entry.author) return { html: "Doesn’t consider this material.", markdown: false };
  return { html: renderMarkdown(entry.reasoning), markdown: true };
}

/** Human-readable reason a finished session stopped short of ratification. */
function stopReason(session) {
  switch (session.state) {
    case "not_approved":
      return session.outcomeReason ? capitalize(tidy(session.outcomeReason)) : "";
    case "errored": {
      const text = stripError(session.fatalError ?? "");
      const quorum = /only (\d+) seat\(s\) remain active; a minimum quorum of (\d+) is required/.exec(text);
      if (quorum) return `Only ${plural(Number(quorum[1]), "seat")} remained active; the council needs at least ${quorum[2]}.`;
      return text ? capitalize(tidy(text)) : "The run failed.";
    }
    case "cancelled": {
      const reason = String(session.cancelReason ?? "");
      const via = /^cancelled via (.+)$/.exec(reason);
      if (via) return `Stopped via ${tidy(via[1])}.`;
      return reason ? capitalize(tidy(reason)) : "The run was stopped.";
    }
    case "orphaned":
      return "The process running this council exited before it finished.";
    default:
      return "";
  }
}

/**
 * A council's name in the list and the header: the first sentence of the task's first line, with
 * shouted leading words calmed to sentence case, cut at a word boundary. The full task stays one
 * click away ("Show full task").
 */
function shortTitle(task, max = 56) {
  let line = String(task ?? "").trim().split("\n")[0].trim();
  if (!line) return "(untitled task)";
  line = line.split(/(?<=[.!?])\s+/)[0].replace(/[.:;,]+$/, "");
  const words = line.split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Z][A-Z0-9-]{1,}$/.test(words[i])) i += 1;
  if (i >= 2 || (i === 1 && words.length > 1 && /^[A-Z]{3,}$/.test(words[0]) && words[0] !== "API")) {
    for (let k = 0; k < i; k++) words[k] = k === 0 ? words[k][0] + words[k].slice(1).toLowerCase() : words[k].toLowerCase();
    line = words.join(" ");
  }
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "")}…`;
}

function clip(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// ---------------------------------------------------------------------------------------------
// Derived session facts

const pendingIds = (session) => (Array.isArray(session?.awaitingHumanRuling) ? session.awaitingHumanRuling : []);

/**
 * Every ratification ballot, one row per vote actually taken. The server's tallies merge a re-vote
 * in the same (phase, round) into the first one, so ballots are rebuilt from each seat's own
 * verdicts, which are chronological: a seat's k-th verdict in a round is its vote in ballot k, and
 * a seat that failed is missing from the ballot it failed on and absent after (it is dropped).
 */
function computeBallots(session) {
  const seats = Array.isArray(session?.seats) ? session.seats : [];
  const rounds = new Map();
  const record = (phase, round, seatId) => {
    const key = `${phase}#${round}`;
    if (!rounds.has(key)) rounds.set(key, { phase, round, seats: new Map() });
    const entry = rounds.get(key);
    if (!entry.seats.has(seatId)) entry.seats.set(seatId, { votes: [], failed: null });
    return entry.seats.get(seatId);
  };
  for (const seat of seats) {
    for (const v of seat.verdicts ?? []) if (VOTE_PHASES.includes(v.phase)) record(v.phase, v.round, seat.id).votes.push(v.verdict);
    for (const f of seat.failures ?? []) if (VOTE_PHASES.includes(f.phase)) record(f.phase, f.round, seat.id).failed = f.status;
  }
  const ordered = [...rounds.values()].sort((a, b) => VOTE_PHASES.indexOf(a.phase) - VOTE_PHASES.indexOf(b.phase) || a.round - b.round);
  const ballots = [];
  for (const entry of ordered) {
    const count = Math.max(...[...entry.seats.values()].map((s) => s.votes.length + (s.failed ? 1 : 0)));
    for (let index = 0; index < count; index++) {
      const ballot = { phase: entry.phase, round: entry.round, index, approve: [], changes: [], reject: [], missing: [] };
      for (const [seatId, s] of entry.seats) {
        if (index < s.votes.length) {
          const vote = s.votes[index];
          (vote === "APPROVE" ? ballot.approve : vote === "APPROVE_WITH_CHANGES" ? ballot.changes : ballot.reject).push(seatId);
        } else if (s.failed && index === s.votes.length) {
          ballot.missing.push(seatId);
        }
      }
      ballots.push(ballot);
    }
  }
  if (ballots.length) return ballots;
  // Fallback for sessions without per-seat verdicts: the server's tallies, counts only.
  const tallies = Array.isArray(session?.deliberation?.ratifications) ? session.deliberation.ratifications : [];
  const filler = (n) => Array.from({ length: Number(n) || 0 }, () => null);
  return tallies.map((t) => ({ phase: t.phase, round: t.round, index: 0, approve: filler(t.approve), changes: filler(t.approveWithChanges), reject: filler(t.reject), missing: filler(t.missing) }));
}

function ratifiedBy(session, ballots = computeBallots(session)) {
  const last = [...ballots].reverse().find((ballot) => ballot.phase === "RATIFY_WORK");
  return last ? last.approve.length + last.changes.length : null;
}

function rejectionCount(ballots) {
  return ballots.reduce((sum, ballot) => sum + ballot.reject.length, 0);
}

function latestReport() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].activityKind === "report") return state.messages[i].text;
  }
  return "";
}

function reportSection(report, title) {
  const lines = String(report ?? "").split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const item = /^-\s+(.*)$/.exec(line);
    if (item) out.push(item[1]);
  }
  return out;
}

function seatStory(seat) {
  const verdicts = Array.isArray(seat.verdicts) ? seat.verdicts : [];
  const failures = Array.isArray(seat.failures) ? seat.failures : [];
  const count = (phase) => verdicts.filter((v) => v.phase === phase).length;
  const work = [];
  if (count("PLAN")) work.push("planned");
  if (count("PLAN_REFINE")) work.push(`revised ${times(count("PLAN_REFINE"))}`);
  if (count("EXECUTE")) work.push("built it");
  if (count("REMEDIATE")) work.push(`fixed objections ${times(count("REMEDIATE"))}`);
  const tests = verdicts.filter((v) => DELIBERATION_PHASES.has(v.phase)).length;
  if (tests) work.push(`ran ${plural(tests, "test")}`);

  const judged = verdicts.filter((v) => FANOUT_PHASES.has(v.phase));
  const rejects = judged.filter((v) => v.verdict === "REJECT");
  let judgement = "";
  let bad = "";
  if (rejects.length) {
    judgement = rejects
      .slice(0, 2)
      .map((v) => `rejected ${SUBJECT[v.phase] ?? humanPhase(v.phase).toLowerCase()} r${v.round + 1}`)
      .join(", ");
    if (rejects.length > 2) judgement += ` and ${rejects.length - 2} more`;
    const last = judged[judged.length - 1];
    if (!failures.length && last && last.verdict !== "REJECT") judgement += ", then approved";
  } else if (judged.some((v) => v.verdict === "APPROVE_WITH_CHANGES")) {
    judgement = "approved with changes";
  } else if (judged.length && !failures.length) {
    judgement = "approved throughout";
  }
  if (failures.length) bad = `dropped out at ${humanPhase(failures[0].phase)}`;
  const text = [work.join(", "), judgement].filter(Boolean).join("; ");
  if (!text && !bad) return { text: seat.calls ? "No verdicts yet" : "Not called yet", bad: "" };
  return { text: capitalize(text), bad: text ? bad : capitalize(bad) };
}

// ---------------------------------------------------------------------------------------------
// Top bar: spend, run summary, connection, document title

function renderMeter(el, label, win) {
  const value = el.querySelector(".meter-value");
  const fill = el.querySelector(".meter-fill");
  if (!win) {
    value.textContent = "—";
    fill.style.width = "0";
    return;
  }
  const total = Number(win.totalUsd) || 0;
  const limit = Number(win.limitUsd) || 0;
  const ratio = limit > 0 ? Math.min(1, total / limit) : 0;
  value.textContent = `${usd(total)} / ${usd(limit)}`;
  fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  el.classList.toggle("is-warn", ratio >= 0.8 && ratio < 1);
  el.classList.toggle("is-over", limit > 0 && total >= limit);
  const repos = Number(win.repositories) || 0;
  const summary = `${label}: ${usd(total)} of ${usd(limit)} spent across ${plural(repos, "repository", "repositories")}, ${usd(win.remainingUsd)} left`;
  el.title = summary;
  el.setAttribute("aria-label", summary);
}

async function loadUsage() {
  try {
    const usage = await api("/api/usage");
    renderMeter(els.meter5h, "Last 5 hours", usage?.fiveHour);
    renderMeter(els.meterWeek, "Last 7 days", usage?.weekly);
  } catch {
    // The session poll reports reachability; a stale meter is harmless.
  }
}

function listCounts() {
  let running = 0;
  let needs = 0;
  let rulings = 0;
  for (const session of state.sessions) {
    if (session.state === "running") running += 1;
    if (groupOf(session) === "needs") needs += 1;
    if (session.state === "awaiting_human" && session.awaitingHumanRuling > 0) rulings += 1;
  }
  return { running, needs, rulings };
}

function renderTopSummary() {
  const { running, needs } = listCounts();
  const parts = [];
  if (running) parts.push(`<span class="rs-running"><span class="glyph" aria-hidden="true">●</span>${esc(`${running} running`)}</span>`);
  if (needs) parts.push(`<span class="rs-needs"><span class="glyph" aria-hidden="true">⚑</span>${esc(`${needs} ${needs === 1 ? "needs" : "need"} you`)}</span>`);
  els.runSummary.innerHTML = parts.join(`<span class="sep" aria-hidden="true">·</span>`);
  els.runSummary.hidden = parts.length === 0;
}

function updateDocumentTitle() {
  const { running, needs, rulings } = listCounts();
  let title = "Conclave";
  if (rulings) title = `(${rulings}) Needs your ruling · Conclave`;
  else if (needs) title = `(${needs}) Needs you · Conclave`;
  else if (running) title = "Running · Conclave";
  if (document.title !== title) document.title = title;
}

/** Only failure is ever shown: a healthy stream is the normal state and needs no badge. */
function renderConn() {
  let text = "";
  let down = false;
  if (state.apiDown) {
    text = "Server unreachable";
    down = true;
  } else if (state.selectedId && (state.conn === "reconnecting" || state.conn === "closed")) {
    text = "Reconnecting…";
  }
  els.connText.textContent = text;
  els.conn.classList.toggle("is-down", down);
  els.conn.hidden = !text;
}

function setConn(conn) {
  state.conn = conn;
  renderConn();
}

function renderBusy() {
  const busy = state.sessions.some((session) => session.state === "running");
  state.busy = busy;
  for (const button of [els.newCouncil, els.welcomeNew]) {
    button.setAttribute("aria-disabled", String(busy));
    if (busy) button.setAttribute("aria-describedby", "new-council-tip");
    else button.removeAttribute("aria-describedby");
  }
  els.welcomeBusy.hidden = !busy;
  els.ncBusy.hidden = !busy;
  els.ncSubmit.disabled = busy;
  if (!busy) els.newCouncilTip.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Session list

function isToday(ts) {
  const date = toDate(ts);
  return date ? dayDiff(date) === 0 : false;
}

function groupOf(session) {
  // "Needs you" means there is something you can do: a ruling to give, or a stopped council you can
  // resume. One that can no longer be resumed (its worktree was pruned) is just history.
  const actionable = (session.state === "awaiting_human" && session.awaitingHumanRuling > 0) || session.resumable === true;
  if ((session.state === "awaiting_human" || session.state === "orphaned") && actionable) return "needs";
  if (session.state === "running") return "running";
  return isToday(session.updatedAt ?? session.startedAt) ? "today" : "earlier";
}

function sessionSignature(session) {
  return session ? [session.state, session.spentUsd, session.currentPhase, session.currentRound, session.phaseOpen, session.awaitingHumanRuling, session.updatedAt].join("|") : "";
}

function sessionItemHtml(session) {
  const current = session.sessionId === state.selectedId;
  const task = String(session.task || "").trim().split("\n")[0] || "(untitled task)";
  const info = stateInfo(session.state, session.awaitingHumanRuling);
  // The list carries names only; state, repository, age and cost live in the tooltip and the page.
  const detail = [info.label, session.repo, relTime(session.updatedAt ?? session.startedAt), usd(session.spentUsd)].filter(Boolean).join(" · ");
  return `<li>
    <button type="button" class="session-item ${toneClass(info.tone)}" id="session-item-${esc(session.sessionId)}" data-id="${esc(session.sessionId)}" title="${esc(`${task}\n${detail}`)}"${current ? ' aria-current="true"' : ""}>
      <span class="si-mark" aria-hidden="true"></span><span class="si-title">${esc(shortTitle(session.task, 40))}</span><span class="sr-only">, ${esc(detail)}</span>
    </button>
  </li>`;
}

function renderSessionList() {
  const body = els.sessionListBody;
  els.sessionCount.textContent = state.sessions.length ? `${state.sessions.length}${state.hasMore ? "+" : ""}` : "";
  els.loadMore.hidden = !state.hasMore;
  renderTopSummary();
  updateDocumentTitle();
  renderBusy();
  if (state.sessions.length === 0) {
    body.innerHTML = `<p class="empty-note">No councils yet. Start one with New council.</p>`;
    return;
  }
  const groups = { needs: [], running: [], today: [], earlier: [] };
  for (const session of state.sessions) groups[groupOf(session)].push(session);
  const titles = { needs: "Needs you", running: "Running", today: "Today", earlier: "Earlier" };
  preserveFocus(body, () => {
    body.innerHTML = Object.entries(groups)
      .filter(([, sessions]) => sessions.length)
      .map(
        ([key, sessions]) => `<section class="group" aria-labelledby="group-${key}">
          <h3 class="group-title" id="group-${key}">${esc(titles[key])}</h3>
          <ul class="session-list">${sessions.map(sessionItemHtml).join("")}</ul>
        </section>`,
      )
      .join("");
  });
}

function applyListOpen() {
  const open = state.listOpen || !isNarrow();
  els.sessionGroups.hidden = !open;
  els.toggleSessions.setAttribute("aria-expanded", String(open));
  els.toggleSessions.textContent = open ? "Hide" : "Show";
}

async function fetchSessionPages() {
  const wanted = state.sessionPages * PAGE_SIZE;
  const collected = [];
  let offset = 0;
  let exhausted = false;
  while (offset < wanted) {
    const limit = Math.min(MAX_SESSION_REQUEST, wanted - offset);
    const page = await api(`/api/sessions?limit=${limit}&offset=${offset}`);
    const sessions = Array.isArray(page?.sessions) ? page.sessions : [];
    collected.push(...sessions);
    // The server says whether more exist: a page can come back short because it skipped a session
    // whose store is unreadable, and that must not hide every older session behind it.
    const more = typeof page?.hasMore === "boolean" ? page.hasMore : sessions.length >= limit;
    if (!more) {
      exhausted = true;
      break;
    }
    offset = typeof page?.nextOffset === "number" ? page.nextOffset : offset + limit;
  }
  return { sessions: collected, hasMore: !exhausted };
}

/** Refreshes every loaded page of the list. Concurrent calls coalesce into one follow-up. */
async function refreshSessions() {
  if (state.sessionsInFlight) {
    state.sessionsAgain = true;
    return state.sessionsInFlight;
  }
  state.sessionsInFlight = (async () => {
    do {
      state.sessionsAgain = false;
      const previous = state.sessions.find((session) => session.sessionId === state.selectedId);
      try {
        const { sessions, hasMore } = await fetchSessionPages();
        state.sessions = sessions;
        state.hasMore = hasMore;
        state.apiDown = false;
        els.sessionsError.hidden = true;
      } catch (error) {
        state.apiDown = error.status === 0;
        els.sessionsError.textContent = `Could not load sessions: ${error.message}`;
        els.sessionsError.hidden = false;
        renderConn();
        break;
      }
      renderConn();
      renderSessionList();
      const next = state.sessions.find((session) => session.sessionId === state.selectedId);
      if (next && sessionSignature(previous) !== sessionSignature(next)) {
        scheduleDetailRefresh();
        if (next.state === "running") catchUpMessages();
      }
    } while (state.sessionsAgain);
  })().finally(() => {
    state.sessionsInFlight = null;
  });
  return state.sessionsInFlight;
}

function firstSessionId() {
  const order = ["needs", "running", "earlier"];
  for (const group of order) {
    const found = state.sessions.find((session) => groupOf(session) === group);
    if (found) return found.sessionId;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Selection, messages and the live stream

function readHash() {
  const match = /^#session=(.+)$/.exec(location.hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function writeHash(id) {
  const hash = id ? `#session=${encodeURIComponent(id)}` : "";
  if (location.hash !== hash) history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
}

function closeEvents() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  clearTimeout(state.detailTimer);
  state.detailTimer = null;
}

async function selectSession(id, { tab = null, focus = false } = {}) {
  if (!id) return;
  const token = ++state.token;
  closeEvents();
  Object.assign(state, {
    selectedId: id,
    session: null,
    sessionJson: "",
    sessionError: null,
    messages: [],
    lastSeq: 0,
    initialLoaded: false,
    catchingUp: false,
    seatFilter: null,
    taskOpen: false,
    confirmStop: false,
    stopRequested: false,
  });
  state.liveSeqs = new Set();
  state.cardOpen = new Map();
  state.expandedMsgs = new Set();
  state.detailsOpen = new Map();
  state.rulingDrafts = new Map();
  writeHash(id);
  hideNotice();
  setConn("idle");
  const listed = state.sessions.find((session) => session.sessionId === id);
  state.tab = tab ?? (listed?.state === "running" ? "timeline" : "overview");
  renderSessionList();

  els.welcome.hidden = true;
  els.view.hidden = false;
  els.header.className = "sh";
  els.header.innerHTML = `<div class="sh-main"><p class="loading">Loading session…</p></div>`;
  els.strip.innerHTML = "";
  for (const name of TABS) els.panels[name].innerHTML = "";
  els.countFindings.textContent = "";
  els.countDisputes.textContent = "";
  els.jump.hidden = true;
  renderRail();
  applyTab();
  els.sessionPanel.scrollTop = 0;
  if (focus) els.sessionPanel.focus({ preventScroll: true });

  await loadDetail(token);
  if (token !== state.token || state.sessionError) return;
  if (!listed && !tab && state.session?.state === "running") {
    state.tab = "timeline";
    applyTab();
  }
  await loadTimeline(id, token);
}

/**
 * The first full load of a session's messages, then live updates. A failed load keeps its error on
 * screen and retries (backing off) instead of posing as an empty timeline with no live stream.
 */
async function loadTimeline(id, token, attempt = 0) {
  const loaded = await loadAllMessages(token);
  if (token !== state.token) return;
  if (!loaded) {
    setTimeout(() => {
      if (token === state.token) loadTimeline(id, token, attempt + 1);
    }, Math.min(30_000, 2_000 * 2 ** attempt));
    return;
  }
  state.initialLoaded = true;
  renderTimeline();
  renderOverview(); // the report's branch and caveats come from the messages
  connectEvents(id, token);
}

async function loadDetail(token = state.token) {
  const id = state.selectedId;
  if (!id) return;
  try {
    const { session } = await api(sessionPath(id));
    if (token !== state.token) return;
    state.sessionError = null;
    const json = JSON.stringify(session);
    if (json === state.sessionJson) return;
    const previous = state.session;
    state.session = session;
    state.sessionJson = json;
    for (const seat of session.seats ?? []) registerSeat(seat.id, seat.label);
    if (previous && previous.state !== session.state) {
      announceTransition(previous, session);
      state.confirmStop = false;
      state.stopRequested = false;
      refreshSessions();
    } else if (previous && pendingIds(previous).length === 0 && pendingIds(session).length > 0) {
      announce("The council needs your ruling.");
    }
    renderSession();
  } catch (error) {
    if (token !== state.token) return;
    if (error.status === 404) {
      state.sessionError = error.message;
      closeEvents();
      els.header.className = "sh";
      els.header.innerHTML = `<div class="sh-main"><h2 class="sh-title">Session not found</h2><p class="sh-meta">${esc(error.message)}</p></div>`;
      for (const name of TABS) els.panels[name].innerHTML = "";
      renderRail();
    } else {
      showNotice(`Could not refresh the session: ${error.message}`, "danger");
    }
  }
}

function announceTransition(previous, session) {
  const pending = pendingIds(session).length;
  const text = {
    approved: "The council ratified the work.",
    not_approved: "The council did not ratify the work.",
    awaiting_human: pending ? "The council needs your ruling." : "",
    errored: "The council run failed.",
    cancelled: "The run stopped.",
    orphaned: "The run was interrupted.",
    running: previous.state !== "running" ? "The council is running." : "",
  }[session.state];
  if (text) announce(text);
}

function scheduleDetailRefresh() {
  if (!state.selectedId || state.detailTimer) return;
  const token = state.token;
  state.detailTimer = setTimeout(() => {
    state.detailTimer = null;
    if (token === state.token) loadDetail(token);
  }, DETAIL_DEBOUNCE_MS);
}

function ingest(messages, live) {
  const fresh = messages.filter((message) => message && Number.isFinite(message.seq) && message.seq > state.lastSeq).sort((a, b) => a.seq - b.seq);
  for (const message of fresh) {
    state.messages.push(message);
    state.lastSeq = message.seq;
    // Only rows that stream in while the timeline is on screen get the arrival animation.
    if (live && state.initialLoaded && state.tab === "timeline") state.liveSeqs.add(message.seq);
    if (live && message.activityKind === "system" && /^Resume failed/.test(String(message.text))) {
      showNotice(tidy(stripError(message.text)), "danger");
      announce("Resume failed.");
    }
  }
  return fresh.length;
}

async function fetchMessagePage(id, token, live) {
  const page = await api(sessionPath(id, `/messages?after=${state.lastSeq}&limit=${MESSAGE_PAGE}`));
  if (token !== state.token) return { stale: true, more: false, added: 0 };
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  const added = ingest(messages, live);
  return { stale: false, more: messages.length >= MESSAGE_PAGE && added > 0, added };
}

async function loadAllMessages(token) {
  const id = state.selectedId;
  state.catchingUp = true;
  try {
    for (;;) {
      const { stale, more } = await fetchMessagePage(id, token, false);
      if (stale) return false;
      if (!more) break;
    }
  } catch (error) {
    if (token !== state.token) return false;
    els.panels.timeline.innerHTML = `<div class="callout tone-danger"><p class="callout-title">Could not load the timeline</p><p>${esc(error.message)}</p></div>`;
    return false;
  } finally {
    if (token === state.token) state.catchingUp = false;
  }
  return true;
}

/** Pulls anything newer than the last message; a fallback for when the stream is quiet. */
async function catchUpMessages() {
  if (state.catchingUp || !state.selectedId || state.sessionError || !state.initialLoaded) return;
  const token = state.token;
  state.catchingUp = true;
  let added = 0;
  try {
    for (;;) {
      const page = await fetchMessagePage(state.selectedId, token, true);
      if (page.stale) return;
      added += page.added;
      if (!page.more) break;
    }
  } catch {
    // The next poll tries again.
  } finally {
    if (token === state.token) state.catchingUp = false;
  }
  if (added > 0) {
    scheduleTimelineRender();
    scheduleDetailRefresh();
  }
}

function connectEvents(id, token) {
  closeEvents();
  const source = new EventSource(sessionPath(id, `/events?lastEventId=${state.lastSeq}`));
  source.onopen = () => {
    if (token === state.token) setConn("live");
  };
  source.onmessage = (event) => {
    if (token !== state.token) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (ingest([message], true) > 0) {
      scheduleTimelineRender();
      scheduleDetailRefresh();
    }
  };
  source.onerror = () => {
    if (token !== state.token) return;
    if (source.readyState === EventSource.CLOSED) {
      setConn("closed");
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(() => {
        if (token === state.token) connectEvents(id, token);
      }, RECONNECT_MS);
    } else {
      setConn("reconnecting");
    }
  };
  state.eventSource = source;
}

// ---------------------------------------------------------------------------------------------
// Rendering the selected session

function renderSession() {
  if (!state.session) return;
  renderHeader();
  renderRail();
  renderOverview();
  renderFindings();
  renderDisputes();
  renderTabCounts();
  renderTimeline();
}

function renderTabCounts() {
  const s = state.session;
  els.countFindings.textContent = String((s?.findings ?? []).length);
  const pending = pendingIds(s).length;
  els.countDisputes.textContent = String((s?.contentions ?? []).length);
  els.countDisputes.classList.toggle("is-attention", pending > 0);
  els.tabs.disputes.setAttribute("aria-label", pending ? `Disputes, ${pending} waiting on you` : `Disputes, ${(s?.contentions ?? []).length}`);
  els.tabs.findings.setAttribute("aria-label", `Findings, ${(s?.findings ?? []).length}`);
}

// --- Header ------------------------------------------------------------------------------------

function titleBlock(session) {
  return `<div class="sh-titlebox">
    <h2 class="sh-title" id="session-title">${esc(shortTitle(session.task, 72))}</h2>
    <button type="button" class="btn-link" id="task-toggle" data-action="toggle-task" aria-expanded="${state.taskOpen}" aria-controls="full-task" hidden>${state.taskOpen ? "Hide full task" : "Show full task"}</button>
  </div>`;
}

function fullTaskBlock(session) {
  return `<div class="sh-task" id="full-task"${state.taskOpen ? "" : " hidden"}>${esc(String(session.task ?? "").trim())}</div>`;
}

function resumeNote(session) {
  const from = session.resumeFrom ? `Continues from ${phaseRound(session.resumeFrom.phase, session.resumeFrom.round)}` : "Continues from the last checkpoint";
  const left = Number(session.budgetRemainingUsd);
  if (!Number.isFinite(left)) return from;
  return left > 0 ? `${from} · ${usd(left)} of budget left` : `${from} · no budget left, so it will stop again`;
}

/**
 * A ratified plain-folder session: its work lives in a private snapshot until applied. The apply is
 * previewed first (exactly which files change) and confirmed; a conflict writes nothing.
 */
function applyBlockHtml(session) {
  const preview = state.applyPreview?.sessionId === session.sessionId ? state.applyPreview : null;
  const error = state.applyError?.sessionId === session.sessionId ? state.applyError.message : "";
  if (error) {
    // The title already says why; show only git's specifics (which files, which hunks).
    const detail = String(error).replace(/^.*?no longer apply cleanly:\s*/is, "").trim();
    return `<div class="callout tone-danger apply-box" role="alert"><p class="callout-title">Not applied: the folder changed since the council's snapshot</p><pre class="apply-conflict">${esc(detail || tidy(error))}</pre><p class="help">Nothing was written. Undo your edits to those files, or start a new council from the folder as it is now.</p></div>`;
  }
  if (!preview) return `<p class="sh-note">Your folder is unchanged. The ratified work is kept in a private snapshot until you apply it.</p>`;
  const mark = { added: "+", modified: "~", deleted: "−" };
  const rows = preview.files.map((file) => `<li class="apply-file is-${esc(file.change)}"><span class="apply-mark" aria-hidden="true">${mark[file.change] ?? "~"}</span><code>${esc(file.path)}</code><span class="sr-only"> ${esc(file.change)}</span></li>`).join("");
  const title = preview.files.length ? `Apply ${plural(preview.files.length, "change")} to ${session.repo ?? "the folder"}?` : "Nothing to apply: the ratified work made no changes.";
  return `<div class="apply-box" role="group" aria-labelledby="apply-title">
    <p class="apply-title" id="apply-title">${esc(title)}</p>
    ${rows ? `<ul class="apply-files">${rows}</ul>` : ""}
    <div class="sh-buttons">
      ${preview.files.length ? `<button type="button" class="btn primary small" id="action-apply-confirm" data-action="apply-confirm">Apply</button>` : ""}
      <button type="button" class="btn small" data-action="apply-cancel">${preview.files.length ? "Cancel" : "Close"}</button>
    </div>
  </div>`;
}

/** The quiet line above the title: when, where, how much. */
function kickerHtml(session, extra = "") {
  const ceiling = Number(session.budgetCeilingUsd);
  const money = Number.isFinite(ceiling) && ceiling > 0 ? `${usd(session.spentUsd)} of ${usd(ceiling)}` : usd(session.spentUsd);
  return `<p class="sh-kicker">${joinMeta([timeTag(session.startedAt, whenLabel(session.startedAt)), `<span>${esc(money)}</span>`, session.repo ? `<span>${esc(session.repo)}</span>` : "", extra])}</p>`;
}

/** One plain sentence: what happened, and why it stopped if it did. */
function statusSentenceHtml(session, ballots) {
  const info = stateInfo(session.state, pendingIds(session).length);
  const seats = (session.seats ?? []).length;
  let lead = `${info.label}.`;
  let rest = "";
  if (session.state === "approved") {
    const x = ratifiedBy(session, ballots);
    lead = x !== null && seats ? `Ratified by ${x} of ${seats} seats.` : "Ratified.";
  } else if (session.state === "awaiting_human") {
    const pending = pendingIds(session).length;
    lead = pending ? `Waiting on your ruling.` : "Ready to resume.";
    rest = pending ? `${plural(pending, "dispute")} could not be settled by policy.` : resumeNote(session) + ".";
  } else if (session.state === "running") {
    lead = "In session.";
    rest = session.currentPhase ? `${phaseRound(session.currentPhase, session.currentRound ?? 0)}.` : "";
  } else {
    const reason = stopReason(session);
    rest = reason ? (/[.!?]$/.test(reason) ? reason : `${reason}.`) : "";
  }
  if (session.worktreeState === "removed" && session.state !== "approved") {
    rest += ` The worktree was removed${session.worktreeRemovedReason ? ` (${tidy(session.worktreeRemovedReason)})` : ""}, so start a new council to continue.`;
  }
  return `<p class="sh-status"><span class="tone-text ${toneClass(info.tone)}">${esc(lead)}</span>${rest ? ` ${esc(rest.trim())}` : ""}</p>`;
}

function finishedHeaderHtml(session) {
  const ballots = computeBallots(session);
  const buttons = [];
  const links = [];
  if (session.resumable) buttons.push(`<button type="button" class="btn primary" id="action-resume" data-action="resume">${session.state === "awaiting_human" ? "Resume now" : "Resume"}</button>`);
  let apply = "";
  if (session.applicable) {
    apply = applyBlockHtml(session);
    if (!state.applyPreview || state.applyPreview.sessionId !== session.sessionId) {
      buttons.push(`<button type="button" class="btn primary" id="action-apply" data-action="apply-preview">Apply to folder</button>`);
    }
  } else if (session.applied) {
    const count = (session.applied.files ?? []).length;
    apply = `<p class="sh-note tone-text tone-success">${esc(`Applied to the folder · ${whenLabel(session.applied.at)} · ${plural(count, "file")}`)}</p>`;
  }
  if (session.branch && session.state === "approved") {
    links.push(`<button type="button" class="btn-quiet" id="action-copy-branch" data-action="copy-branch">Copy branch</button>`);
    links.push(`<button type="button" class="btn-quiet" id="action-copy-diff" data-action="copy-diff">Copy diff command</button>`);
  } else if (session.branch && session.worktreeState !== "removed" && session.worktreeState !== "none") {
    links.push(`<button type="button" class="btn-quiet" id="action-copy-branch" data-action="copy-branch">Copy branch</button>`);
  }
  links.push(`<button type="button" class="btn-quiet" data-action="goto-tab" data-tab="timeline">Read the transcript</button>`);
  const actions = `<div class="sh-actions">${buttons.join("")}${links.join("")}</div>${apply}`;
  return `<div class="sh-main">${kickerHtml(session)}${titleBlock(session)}${statusSentenceHtml(session, ballots)}</div>${actions}${fullTaskBlock(session)}`;
}

function stepperHtml(session) {
  const current = STEPS.findIndex((step) => step.phases.includes(session.currentPhase));
  const items = STEPS.map((step, index) => {
    if (index === current) {
      const label = `${step.label} · ${roundLabel(session.currentRound ?? 0)}`;
      return `<li class="step" aria-current="step">${esc(label)}</li>`;
    }
    if (index < current) return `<li class="step is-done"><span class="step-check" aria-hidden="true">✓</span>${esc(step.label)}<span class="sr-only"> (done)</span></li>`;
    return `<li class="step">${esc(step.label)}</li>`;
  });
  return `<ol class="stepper" aria-label="Progress">${items.join("")}</ol>`;
}

function runningHeaderHtml(session) {
  const spent = Number(session.spentUsd) || 0;
  const ceiling = Number(session.budgetCeilingUsd);
  const ratio = Number.isFinite(ceiling) && ceiling > 0 ? Math.min(1, spent / ceiling) : 0;
  const bar = Number.isFinite(ceiling) && ceiling > 0 ? `<span class="spend-bar${ratio >= 0.8 ? " is-warn" : ""}" aria-hidden="true"><span style="width:${(ratio * 100).toFixed(1)}%"></span></span>` : "";

  let actions;
  if (state.stopRequested) {
    actions = `<div class="sh-actions"><button type="button" class="btn danger" id="action-stop" disabled>Stopping…</button><p class="sh-note">Stops at the next checkpoint.</p></div>`;
  } else if (state.confirmStop) {
    // Full width under the header, so confirming never squeezes the title or the stepper.
    actions = `<div class="confirm" role="group" aria-labelledby="stop-confirm-text">
      <p id="stop-confirm-text">Stop this run? It stops at the next checkpoint. The worktree is kept, so you can resume.</p>
      <div class="sh-buttons">
        <button type="button" class="btn small" id="action-stop-cancel" data-action="stop-cancel">Keep running</button>
        <button type="button" class="btn small danger" id="action-stop-confirm" data-action="stop-confirm">Stop run</button>
      </div>
    </div>`;
  } else {
    actions = `<div class="sh-actions"><button type="button" class="btn danger" id="action-stop" data-action="stop">Stop run</button><button type="button" class="btn-quiet" data-action="goto-tab" data-tab="timeline">Watch the transcript</button></div>`;
  }
  return `<div class="sh-main">${kickerHtml(session, bar)}${titleBlock(session)}${statusSentenceHtml(session, [])}${stepperHtml(session)}</div>${actions}${fullTaskBlock(session)}`;
}

/** Collapses a thread that repeats itself across rounds into one entry per distinct message. */
function dedupeThread(thread) {
  const out = [];
  for (const entry of Array.isArray(thread) ? thread : []) {
    const same = out.find((item) => item.author === entry.author && item.stance === entry.stance && item.reasoning === entry.reasoning);
    if (same) same.count += 1;
    else out.push({ ...entry, count: 1 });
  }
  return out;
}

function threadHtml(thread) {
  const entries = dedupeThread(thread);
  if (!entries.length) return "";
  return `<ol class="d-thread">${entries
    .map((entry) => {
      const reason = explainThreadReason(entry);
      const stance = STANCES[entry.stance] ?? String(entry.stance ?? "").toLowerCase().replaceAll("_", " ");
      const repeat = entry.count > 1 ? ` <span class="d-repeat">· in ${entry.count} rounds</span>` : "";
      return `<li class="d-entry">
        <span class="row-gutter">${dotHtml(entry.author)}</span>
        <div>
          <p class="d-who">${seatNameHtml(entry.author)} <span class="d-stance">${esc(stance)}</span>${repeat}</p>
          ${reason.markdown ? `<div class="md">${reason.html}</div>` : `<p class="muted">${reason.html}</p>`}
        </div>
      </li>`;
    })
    .join("")}</ol>`;
}

function rulingHeaderHtml(session, pending) {
  const contentions = (session.contentions ?? []).filter((c) => pending.includes(c.contentionId));
  const cards = contentions
    .map((contention, index) => {
      // Keyed by the contention, not its position: when an earlier ruling is recorded the list
      // shifts, and a draft (or focus) keyed by position would land in a different dispute's box.
      const base = rulingBase(contention.contentionId);
      const draft = state.rulingDrafts.get(contention.contentionId) ?? "";
      const targets = (contention.targets ?? []).map((target) => `<code class="target">${esc(target)}</code>`).join(" ");
      const why = contention.ruling?.reasoning ? `<p class="rc-why"><strong>Why it’s yours:</strong> ${explainPolicy(contention.ruling.reasoning)}</p>` : "";
      return `<section class="rc" aria-labelledby="${base}-title">
        <h3 class="rc-title" id="${base}-title"><span class="rc-count">Ruling ${index + 1} of ${contentions.length}</span>${severityBadge(contention.severity)}${targets}</h3>
        ${why}
        ${threadHtml(contention.thread)}
        <form class="ruling-form" data-cid="${esc(contention.contentionId)}" novalidate>
          <label class="label" for="${base}-reason">Your reason <span class="req">(required)</span></label>
          <textarea id="${base}-reason" rows="3" required aria-required="true" aria-describedby="${base}-help ${base}-error">${esc(draft)}</textarea>
          <p class="help" id="${base}-help"><strong>Uphold</strong>: the objection stands and the council must resolve it. <strong>Dismiss</strong>: the objection is overruled and will not be raised again.</p>
          <p class="field-error" id="${base}-error" role="alert" hidden></p>
          <div class="rc-actions">
            <button type="submit" class="btn" id="${base}-uphold" value="UPHELD">Uphold</button>
            <button type="submit" class="btn" id="${base}-dismiss" value="DISMISSED">Dismiss</button>
          </div>
        </form>
      </section>`;
    })
    .join("");
  return `<div class="sh-main">${kickerHtml(session)}${titleBlock(session)}${statusSentenceHtml(session, [])}</div>${fullTaskBlock(session)}<div class="rulings">${cards}</div>`;
}

function renderHeader() {
  const session = state.session;
  if (!session) return;
  const pending = pendingIds(session);
  const ruling = session.state === "awaiting_human" && pending.length > 0;
  const html = ruling ? rulingHeaderHtml(session, pending) : session.state === "running" ? runningHeaderHtml(session) : finishedHeaderHtml(session);
  preserveFocus(els.header, () => {
    els.header.className = `sh${ruling ? " is-ruling" : ""}`;
    els.header.innerHTML = html;
  });
  syncTaskToggle();
}

/** "Show full task" appears only when the one-line title is actually cut off. */
function syncTaskToggle() {
  const title = $("session-title");
  const toggle = $("task-toggle");
  if (!title || !toggle) return;
  const task = String(state.session?.task ?? "").trim();
  const truncated = task !== shortTitle(task, 72) || title.scrollWidth > title.clientWidth + 1;
  toggle.hidden = !(truncated || state.taskOpen);
}

// --- Overview ----------------------------------------------------------------------------------

function severityPhrase(counts) {
  return SEVERITIES.filter((sev) => counts[sev]).map((sev) => `${counts[sev]} ${sev.toLowerCase()}`).join(", ");
}

function settlement(contention) {
  const ruling = contention.ruling;
  if (contention.status === "HUMAN_ARBITRATION") return { text: "Escalated to you.", label: "Needs your ruling", tone: "attention" };
  if (contention.status === "SUPERSEDED") return { text: "Superseded: a later audit no longer raised it.", label: "Superseded", tone: "neutral" };
  if (contention.status === "OPEN" && !ruling) return { text: "Still open.", label: "Open", tone: "info" };
  if (!ruling) return { text: "", label: capitalize(String(contention.status ?? "").toLowerCase()), tone: "neutral" };
  const reason = String(ruling.reasoning ?? "");
  if (ruling.source === "human") {
    const verb = ruling.ruling === "UPHELD" ? "upheld" : "dismissed";
    return { html: `You ${verb} it: “${esc(reason)}”`, label: ruling.ruling === "UPHELD" ? "Upheld by you" : "Dismissed by you", tone: ruling.ruling === "UPHELD" ? "warning" : "neutral" };
  }
  if (ruling.ruling === "UPHELD") {
    return { text: /executed evidence/.test(reason) ? "Upheld: a test reproduced the claim." : "Upheld by weighted policy.", label: "Upheld", tone: "warning" };
  }
  if (ruling.ruling === "DISMISSED") {
    return { text: /executed evidence/.test(reason) ? "Dismissed: the test did not reproduce the claim." : "Dismissed by weighted policy.", label: "Dismissed", tone: "neutral" };
  }
  return { text: "Deferred to a later round.", label: "Deferred", tone: "neutral" };
}

function nextStepsHtml(session) {
  const report = latestReport();
  const parts = [];
  if (session.state === "approved" && session.branch) {
    const base = /single commit on top of ([0-9a-f]{7,40})/.exec(report)?.[1];
    parts.push(`<p>The ratified work is committed on ${code(session.branch)}${base ? ` as a single commit on top of ${code(base.slice(0, 12))}` : ""}.</p>`);
    parts.push(`<p>Review it with ${code(`git diff HEAD...${session.branch}`)}, then merge it yourself. Conclave never merges or pushes.</p>`);
    const caveats = reportSection(report, "Caveats");
    if (caveats.length) parts.push(`<ul>${caveats.map((c) => `<li>${renderInline(tidy(c))}</li>`).join("")}</ul>`);
  } else if (session.state === "awaiting_human" && pendingIds(session).length) {
    parts.push(`<p>Rule on each escalated dispute at the top of this page, then resume.</p>`);
  } else if (session.resumable) {
    parts.push(`<p>${esc(resumeNote(session))}.${session.worktreeState === "kept" ? " The worktree is kept, so nothing is lost." : ""}</p>`);
  } else if (session.worktreeState === "removed" && session.state !== "approved") {
    const why = session.worktreeRemovedReason ? ` (${esc(tidy(session.worktreeRemovedReason))})` : "";
    parts.push(`<p>Worktree removed${why}. Start a new council to continue.</p>`);
  }
  return parts.length ? `<div class="next">${parts.join("")}</div>` : "";
}

function section(title, body) {
  return body ? `<section class="section"><h3 class="section-title">${esc(title)}</h3>${body}</section>` : "";
}

/** Where each seat ended up, in a word or two. */
function seatOutcome(seat) {
  if ((seat.failures ?? []).length) return { text: "dropped out", tone: "danger" };
  const judged = (seat.verdicts ?? []).filter((v) => FANOUT_PHASES.has(v.phase));
  const last = judged[judged.length - 1];
  if (!last) return { text: seat.calls ? "no vote yet" : "not called yet", tone: "neutral" };
  if (last.verdict === "REJECT") return { text: "rejected", tone: "danger" };
  if (last.verdict === "APPROVE_WITH_CHANGES") return { text: "approved with changes", tone: "neutral" };
  return { text: "approved", tone: "neutral" };
}

function councilLineHtml(session) {
  const seats = session.seats ?? [];
  if (!seats.length) return "";
  return `<p class="council">${seats
    .map((seat) => {
      const outcome = seatOutcome(seat);
      const word = outcome.tone === "danger" ? `<span class="tone-text tone-danger">${esc(outcome.text)}</span>` : esc(outcome.text);
      return `<button type="button" class="cs-seat" data-seat="${esc(seat.id)}" title="${esc(`${humanRole(seat.role)} · ${usd(seat.spentUsd)} · ${seatModelLine(seat) || "default model"}. Show only this seat in the transcript.`)}">${esc(nameOf(seat.id))} ${word}</button>`;
    })
    .join(`<span class="sep" aria-hidden="true"> · </span>`)}</p>`;
}

/** A dispute's one-line name: its first target, which is the claim in the work being argued over. */
function disputeLine(contention) {
  const target = (contention.targets ?? [])[0];
  if (target) return clip(String(target).replace(/\s+/g, " "), 110);
  return contention.category ? capitalize(String(contention.category).replaceAll("-", " ")) : "Dispute";
}

function renderOverview() {
  const session = state.session;
  if (!session) return;
  const out = [];
  out.push(section("Council", councilLineHtml(session)));

  const contentions = [...(session.contentions ?? [])];
  if (contentions.length) {
    const pending = pendingIds(session);
    const weight = (c) => (pending.includes(c.contentionId) ? 0 : c.status === "OPEN" ? 1 : c.status === "SUPERSEDED" ? 3 : 2);
    contentions.sort((a, b) => weight(a) - weight(b) || severityRank(a.severity) - severityRank(b.severity));
    const shown = contentions.slice(0, 3);
    const rows = shown
      .map((c) => {
        const settled = settlement(c);
        const sev = SEVERITIES.includes(c.severity) ? capitalize(c.severity.toLowerCase()) : "—";
        return `<li><button type="button" class="dl-row" data-action="goto-tab" data-tab="disputes"><span class="dl-sev">${esc(sev)}</span><span class="dl-text">${esc(disputeLine(c))}</span><span class="dl-state tone-text ${toneClass(settled.tone)}">${esc(settled.label)}</span></button></li>`;
      })
      .join("");
    const more = contentions.length > shown.length ? `<button type="button" class="btn-quiet more-link" data-action="goto-tab" data-tab="disputes">${esc(plural(contentions.length - shown.length, "more dispute"))}</button>` : "";
    out.push(section(pending.length ? "Needs your decision" : "Disputes", `<ul class="dl">${rows}</ul>${more}`));
  }

  const next = nextStepsHtml(session);
  if (next && session.state === "approved") out.push(section("Next", next));

  const findings = session.findings ?? [];
  if (findings.length) {
    const blocking = findings.filter((f) => f.severity === "BLOCKER").length;
    out.push(`<button type="button" class="findings-link" data-action="goto-tab" data-tab="findings">${esc(`${plural(findings.length, "finding")}${blocking ? `, ${blocking} blocking` : ""}`)} <span aria-hidden="true">→</span></button>`);
  }
  els.panels.overview.innerHTML = `<div class="ov">${out.join("")}</div>`;
}

// --- Findings ----------------------------------------------------------------------------------

function findingStatus(finding, session) {
  if (finding.addressed) return { label: "✓ Addressed", tone: "success" };
  // A finding that was disputed carries its dispute's outcome.
  const dispute = (session.contentions ?? []).find((c) => (c.targets ?? []).includes(finding.target) && (c.thread ?? []).some((e) => e.author === finding.seat));
  if (dispute?.status === "HUMAN_ARBITRATION") return { label: "Needs your ruling", tone: "attention" };
  if (dispute?.ruling?.ruling === "DISMISSED") return { label: dispute.ruling.source === "human" ? "Dismissed by you" : "Dismissed", tone: "neutral" };
  if (dispute?.status === "SUPERSEDED") return { label: "Superseded", tone: "neutral" };
  // On a ratified session every seat voted to approve with this finding on the table: a serious one
  // was cleared by that vote (e.g. by a plan revision in between), a minor one never blocked at all.
  if (session.state === "approved") {
    return severityRank(finding.severity) <= 1 ? { label: "Cleared at ratification", tone: "neutral" } : { label: "Non-blocking", tone: "neutral" };
  }
  return severityRank(finding.severity) <= 1 ? { label: "Open", tone: "warning" } : { label: "Open", tone: "neutral" };
}

function verificationLabel(result) {
  return { TRUE: { label: "Reproduced", tone: "warning" }, FALSE: { label: "Not reproduced", tone: "success" }, INCONCLUSIVE: { label: "Inconclusive", tone: "neutral" } }[result] ?? { label: "Unknown", tone: "neutral" };
}

function findingRowHtml(finding, session) {
  const status = findingStatus(finding, session);
  const confidence = Number.isFinite(finding.confidence) ? `${Math.round(finding.confidence * 100)}% confidence` : "";
  const meta = [finding.category ? capitalize(String(finding.category).replaceAll("-", " ")) : "", confidence].filter(Boolean).join(" · ");
  const runs = (session.verifications ?? []).filter((run) => run.findingId === finding.id);
  const result = runs.length ? verificationLabel(runs[runs.length - 1].result) : null;
  const test = finding.falsifiableTest
    ? `<div class="f-test"><span class="f-test-label">Falsifiable test</span><code>${esc(finding.falsifiableTest)}</code>${result ? badge(result.label, result.tone) : ""}</div>`
    : "";
  return `<li class="f-row">
    <div class="f-head">${severityBadge(finding.severity)}${finding.target ? `<code class="target">${esc(finding.target)}</code>` : ""}<span class="f-by">${dotHtml(finding.seat)}${seatNameHtml(finding.seat)}</span><span class="f-status tone-text ${toneClass(status.tone)}">${esc(status.label)}</span></div>
    <div class="f-desc md">${renderMarkdown(finding.description)}</div>
    ${meta ? `<p class="f-meta">${esc(meta)}</p>` : ""}
    ${test}
  </li>`;
}

function renderFindings() {
  const session = state.session;
  if (!session) return;
  const findings = [...(session.findings ?? [])].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || Number(a.addressed) - Number(b.addressed));
  if (!findings.length) {
    els.panels.findings.innerHTML = `<p class="empty-note">No findings. No seat filed anything.</p>`;
    return;
  }
  const ratified = session.state === "approved";
  const material = findings.filter((f) => severityRank(f.severity) <= 1 || !SEVERITIES.includes(f.severity));
  const minor = findings.filter((f) => f.severity === "MINOR" || f.severity === "NIT");
  let html = material.length ? `<ul class="f-list">${material.map((f) => findingRowHtml(f, session)).join("")}</ul>` : `<p class="empty-note">No blocker or major findings.</p>`;
  if (minor.length) {
    const list = `<ul class="f-list">${minor.map((f) => findingRowHtml(f, session)).join("")}</ul>`;
    if (ratified) {
      const open = state.detailsOpen.get("minor") ?? false;
      const counts = {};
      for (const f of minor) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      html += `<details class="f-more" data-key="minor"${open ? " open" : ""}><summary>${CHEVRON}${esc(`${plural(minor.length, "non-blocking finding")} (${severityPhrase(counts)})`)}</summary>${list}</details>`;
    } else {
      html += `<div class="f-more is-flat">${list}</div>`;
    }
  }
  els.panels.findings.innerHTML = html;
}

// --- Disputes ----------------------------------------------------------------------------------

function renderDisputes() {
  const session = state.session;
  if (!session) return;
  const contentions = session.contentions ?? [];
  const pending = pendingIds(session);
  const ballots = computeBallots(session);
  const rejections = rejectionCount(ballots);
  const planRejections = ballots.filter((b) => b.phase === "RATIFY_PLAN").reduce((n, b) => n + b.reject.length, 0);
  const rejectionNote = rejections
    ? `<p class="d-foot">${esc(`${plural(rejections, "rejection")} in the votes ${rejections === 1 ? "was" : "were"} ${session.state === "approved" ? "resolved by" : "followed by"} ${planRejections === rejections ? "revising the plan" : "revision"}.`)}</p>`
    : "";
  if (!contentions.length) {
    els.panels.disputes.innerHTML = `<p class="empty-note">No formal disputes.</p>${rejectionNote}`;
    return;
  }
  const items = contentions
    .map((contention, index) => {
      const settled = settlement(contention);
      const targets = (contention.targets ?? []).map((t) => `<code class="target">${esc(t)}</code>`).join("");
      const runs = (session.verifications ?? []).filter((run) => run.contentionId === contention.contentionId);
      const verification = runs
        .map((run, runIndex) => {
          const result = verificationLabel(run.result);
          const key = `out:${index}:${runIndex}`;
          const open = state.detailsOpen.get(key) ?? false;
          return `<div class="d-box">
            <div class="d-box-head"><span class="d-box-title">Verification</span>${badge(result.label, result.tone)}<span class="muted">${esc(nameOf(ownerOf(run.findingId)))}’s claim</span></div>
            ${run.command ? `<p>Ran ${code(run.command)}</p>` : ""}
            ${run.output ? `<details class="d-output" data-key="${esc(key)}"${open ? " open" : ""}><summary>What it showed</summary><pre>${esc(run.output)}</pre></details>` : ""}
          </div>`;
        })
        .join("");
      const ruling = contention.ruling && contention.status !== "HUMAN_ARBITRATION"
        ? `<div class="d-box">
            <div class="d-box-head"><span class="d-box-title">Ruling</span>${badge(settled.label, settled.tone)}<span class="muted">${esc(contention.ruling.source === "human" ? "by you" : `by policy${(contention.ruling.arbiters ?? []).length ? `, arbiters ${joinWords(contention.ruling.arbiters.map(nameOf))}` : ""}`)}</span></div>
            ${contention.ruling.reasoning ? `<p>${esc(tidy(contention.ruling.reasoning))}</p>` : ""}
          </div>`
        : "";
      const awaiting = pending.includes(contention.contentionId)
        ? `<p class="d-pending">Waiting on your ruling. <button type="button" class="btn small" data-action="goto-ruling" data-cid="${esc(contention.contentionId)}">Rule on it</button></p>`
        : "";
      return `<li class="d-item">
        <div class="d-head">${badge(settled.label, settled.tone)}${severityBadge(contention.severity)}${targets}${contention.category ? `<span class="muted">${esc(capitalize(String(contention.category).replaceAll("-", " ")))}</span>` : ""}</div>
        ${threadHtml(contention.thread)}
        ${verification}
        ${ruling}
        ${awaiting}
      </li>`;
    })
    .join("");
  els.panels.disputes.innerHTML = `<ol class="d-list">${items}</ol>${rejectionNote}`;
}

// --- Timeline ----------------------------------------------------------------------------------

function buildTimeline() {
  const session = state.session;
  const task = String(session?.task ?? "").trim();
  const pre = [];
  const blocks = [];
  let card = null;
  let skippedTask = false;
  const repeats = new Map();
  const newCard = (phase, round, seq, ts) => {
    const key = `${phase}#${round}`;
    const repeat = repeats.get(key) ?? 0;
    repeats.set(key, repeat + 1);
    card = { key: `c${Number(seq)}`, phase, round, repeat, items: [], ts, report: null };
    blocks.push({ type: "card", card });
    return card;
  };
  for (const m of state.messages) {
    if (m.kind === "user") {
      if (!skippedTask && String(m.text ?? "").trim() === task) {
        skippedTask = true;
        continue;
      }
      if (card) card.items.push({ type: "user", m });
      else pre.push({ html: `You: ${esc(m.text)}` });
      continue;
    }
    if (m.activityKind === "phase") {
      newCard(m.phase, m.round, m.seq, m.ts);
      continue;
    }
    if (m.activityKind === "report") {
      if (card && card.phase === "REPORT" && !card.report) card.report = m;
      else newCard("REPORT", m.round ?? null, m.seq, m.ts).report = m;
      card = null;
      continue;
    }
    if (m.activityKind === "seat") {
      if (!card || card.phase !== m.phase || card.round !== m.round) newCard(m.phase, m.round, m.seq, m.ts);
      card.items.push({ type: "seat", m });
      continue;
    }
    const described = describeSystem(m.text, m);
    if (described.hidden) continue;
    if (!m.phase) {
      if (!blocks.length) pre.push({ html: described.html });
      else blocks.push({ type: "marker", m, described });
      continue;
    }
    if (!card || card.phase !== m.phase || card.round !== m.round) newCard(m.phase, m.round, m.seq, m.ts);
    card.items.push({ type: "system", m, described });
  }
  return { pre, blocks };
}

function cardInfo(card, live) {
  const seatItems = card.items.filter((item) => item.type === "seat");
  const systemItems = card.items.filter((item) => item.type === "system");
  const tags = [];
  let summary = "";
  let attention = systemItems.some((item) => item.described.tone === "danger" || item.described.tone === "attention" || item.described.tone === "warning");
  if (card.report) {
    const outcome = /^Outcome: (.+)$/m.exec(String(card.report.text ?? ""))?.[1] ?? "";
    summary = { RATIFIED: "ratified", "NOT APPROVED": "not ratified", "AWAITING HUMAN ARBITRATION": "waiting on your ruling", CANCELLED: "stopped", FAILED: "failed" }[outcome.trim()] ?? "council report";
  } else if (FANOUT_PHASES.has(card.phase)) {
    const votes = seatItems.filter((item) => item.m.verdict?.overall_verdict);
    const failed = seatItems.length - votes.length;
    const approve = votes.filter((item) => item.m.verdict.overall_verdict !== "REJECT").length;
    const reject = votes.length - approve;
    const changes = votes.filter((item) => item.m.verdict.overall_verdict === "APPROVE_WITH_CHANGES").length;
    summary = seatItems.length ? `${approve}/${seatItems.length} approve` : live ? "waiting for verdicts" : "no verdicts";
    if (changes) tags.push(badge(`${changes} with changes`, "warning"));
    if (reject) tags.push(badge(`${reject} reject`, "danger"));
    if (failed) tags.push(badge(`${failed} dropped out`, "danger"));
    attention = attention || reject > 0 || failed > 0;
  } else if (EXECUTOR_PHASES.has(card.phase)) {
    const who = seatItems[0]?.m.seat;
    summary = seatItems.length ? `${nameOf(who)} ${EXECUTOR_SUMMARY[card.phase]}` : live ? "in progress" : "stopped before a response";
    attention = attention || seatItems.some((item) => !item.m.verdict);
  } else if (DELIBERATION_PHASES.has(card.phase)) {
    const rulings = systemItems.filter((item) => /^Arbitration on /.test(String(item.m.text)));
    const escalated = systemItems.filter((item) => /^Escalated /.test(String(item.m.text))).length;
    summary = rulings.length ? `${plural(rulings.length, "dispute")} arbitrated` : live ? "arbitrating" : "nothing to arbitrate";
    if (escalated) tags.push(badge(`${escalated} to you`, "attention"));
    attention = attention || rulings.length > 0 || seatItems.length > 0;
  }
  return { summary, tags, attention };
}

function seatRowHtml(item, card) {
  const m = item.m;
  const verdict = m.verdict && typeof m.verdict === "object" ? m.verdict : null;
  const live = state.liveSeqs.has(m.seq) ? " is-live" : "";
  const time = `<span class="row-time">${timeTag(m.ts)}</span>`;
  const head = (extra) => `<div class="row-head"><span class="row-name">${seatNameHtml(m.seat)}</span>${extra}${time}</div>`;

  if (!verdict) {
    const failure = (state.session?.seats ?? []).find((seat) => seat.id === m.seat)?.failures?.find((f) => f.phase === m.phase && f.round === m.round);
    const status = String(failure?.status ?? "unavailable").toLowerCase();
    return `<div class="row${live}"><span class="row-gutter">${dotHtml(m.seat)}</span><div class="row-main">
      ${head(`<span class="row-flag">dropped out · ${esc(status)}</span>`)}
      <p class="row-err">${esc(tidy(stripError(m.text, m.seat)))}</p>
    </div></div>`;
  }

  let label = "";
  let text = m.text;
  const verifying = /^Verifying (\S+): /.exec(String(m.text ?? ""));
  if (verifying || DELIBERATION_PHASES.has(card.phase)) {
    const result = verdict.overall_verdict === "REJECT" ? "TRUE" : verdict.overall_verdict === "APPROVE" ? "FALSE" : "INCONCLUSIVE";
    const info = verificationLabel(result);
    label = `<span class="muted">ran ${esc(nameOf(ownerOf(verifying?.[1])))}’s test</span>${badge(info.label, info.tone)}`;
    if (verifying) text = String(m.text).slice(verifying[0].length);
  } else if (EXECUTOR_PHASES.has(card.phase)) {
    label = "";
  } else if (verdict.overall_verdict === "APPROVE") {
    label = `<span class="row-ok" role="img" aria-label="approved">✓</span>`;
  } else {
    const v = VERDICTS[verdict.overall_verdict] ?? { label: String(verdict.overall_verdict ?? "No verdict"), tone: "neutral" };
    label = badge(v.label, v.tone);
  }

  const expanded = state.expandedMsgs.has(m.seq);
  const bodyId = `mb-${Number(m.seq)}`;
  const findings = FANOUT_PHASES.has(card.phase) && Array.isArray(verdict.findings) ? verdict.findings : [];
  const findingsHtml = findings.length
    ? `<ul class="row-findings" aria-label="Findings">${findings
        .map((f) => `<li>${severityBadge(f.severity)}${f.target ? `<code class="target">${esc(f.target)}</code>` : ""}<span class="finding-text inline-md">${renderInline(f.description)}</span></li>`)
        .join("")}</ul>`
    : "";
  return `<div class="row${live}"><span class="row-gutter">${dotHtml(m.seat)}</span><div class="row-main">
    ${head(label)}
    <div class="row-body md${expanded ? "" : " clamp"}" id="${bodyId}">${renderMarkdown(text)}</div>
    <button type="button" class="btn-link more-btn" id="more-${Number(m.seq)}" data-more="${Number(m.seq)}" aria-controls="${bodyId}" aria-expanded="${expanded}"${expanded ? "" : " hidden"}>${expanded ? "Show less" : "Show more"}</button>
    ${findingsHtml}
  </div></div>`;
}

function systemRowHtml(item) {
  const live = state.liveSeqs.has(item.m.seq) ? " is-live" : "";
  return `<div class="row sys ${toneClass(item.described.tone)}${live}"><span class="row-gutter"><span class="sys-mark" aria-hidden="true"></span></span><p class="row-main">${item.described.html}${timeTag(item.m.ts)}</p></div>`;
}

function userRowHtml(item) {
  return `<div class="row"><span class="row-gutter">${dotHtml("human")}</span><div class="row-main">
    <div class="row-head"><span class="row-name seat-name is-neutral">You</span><span class="row-time">${timeTag(item.m.ts)}</span></div>
    <div class="row-body md">${renderMarkdown(item.m.text)}</div>
  </div></div>`;
}

function waitingRowHtml(card) {
  const session = state.session;
  let who = [];
  if (EXECUTOR_PHASES.has(card.phase)) {
    who = card.items.some((i) => i.type === "seat") ? [] : ["claude"];
  } else if (FANOUT_PHASES.has(card.phase)) {
    const answered = new Set(card.items.filter((i) => i.type === "seat").map((i) => i.m.seat));
    who = (session?.seats ?? []).filter((seat) => !(seat.failures ?? []).length && !answered.has(seat.id)).map((seat) => seat.id);
  }
  const text = who.length ? `Waiting for ${joinWords(who.map(nameOf))}…` : DELIBERATION_PHASES.has(card.phase) ? "Arbitrating…" : "Working…";
  return `<div class="row sys waiting"><span class="row-gutter"><span class="sys-mark" aria-hidden="true"></span></span><p class="row-main">${esc(text)}</p></div>`;
}

function cardHtml(card, { isLast, running, filter }) {
  const items = filter ? card.items.filter((item) => item.type === "seat" && item.m.seat === filter) : card.items;
  if (filter && !items.length) return "";
  const live = isLast && running && !card.report;
  if (!filter && !items.length && !card.report && !live && card.phase === "INTAKE") return "";
  const info = cardInfo(card, live);
  const title = card.report ? "Report" : `${humanPhase(card.phase)}${Number.isInteger(card.round) ? ` · ${roundLabel(card.round)}` : ""}${card.repeat ? " · re-vote" : ""}`;
  const hasBody = items.length > 0 || !!card.report || live;
  const storeKey = filter ? `f:${card.key}` : card.key;
  const defaultOpen = filter ? true : card.report ? false : info.attention || live;
  const open = hasBody && (state.cardOpen.has(storeKey) ? state.cardOpen.get(storeKey) : defaultOpen);
  const bodyId = `tl-body-${card.key}`;
  const inner = `${CHEVRON}<span class="tl-text"><span class="tl-title">${esc(title)}</span> <span class="tl-sum">${esc(info.summary)}</span></span>${info.tags.length ? `<span class="tl-tags">${info.tags.join("")}</span>` : ""}`;
  const head = hasBody
    ? `<h3 class="tl-card-head"><button type="button" class="tl-toggle" id="tl-btn-${card.key}" data-card="${esc(storeKey)}" aria-expanded="${open}" aria-controls="${bodyId}">${inner}</button></h3>`
    : `<h3 class="tl-card-head"><span class="tl-static">${inner}</span></h3>`;
  if (!hasBody) return `<article class="tl-card">${head}</article>`;
  let rows = items
    .map((item) => (item.type === "seat" ? seatRowHtml(item, card) : item.type === "system" ? systemRowHtml(item) : userRowHtml(item)))
    .join("");
  if (card.report) rows += `<div class="row"><span class="row-gutter"></span><div class="row-main"><div class="md">${renderMarkdown(tidyMoney(card.report.text))}</div></div></div>`;
  if (live && !filter) rows += waitingRowHtml(card);
  return `<article class="tl-card">${head}<div class="tl-body" id="${bodyId}"${open ? "" : " hidden"}>${rows}</div></article>`;
}

function nearBottom() {
  const el = isNarrow() ? document.scrollingElement : els.sessionPanel;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollToBottom() {
  const el = isNarrow() ? document.scrollingElement : els.sessionPanel;
  el.scrollTop = el.scrollHeight;
  els.jump.hidden = true;
}

function scheduleTimelineRender() {
  if (state.timelineFrame) return;
  state.timelineFrame = requestAnimationFrame(() => {
    state.timelineFrame = 0;
    renderTimeline();
  });
}

function renderTimeline() {
  const panel = els.panels.timeline;
  if (!state.selectedId || state.sessionError) return;
  if (!state.initialLoaded) {
    if (!panel.innerHTML) panel.innerHTML = `<p class="loading">Loading timeline…</p>`;
    return;
  }
  const visible = state.tab === "timeline";
  const running = state.session?.state === "running";
  const stick = visible && running && nearBottom();
  const hadLive = state.liveSeqs.size > 0;
  const filter = state.seatFilter;
  const { pre, blocks } = buildTimeline();
  const lastCard = blocks.reduce((last, block, index) => (block.type === "card" ? index : last), -1);
  const parts = [];
  if (filter) {
    parts.push(`<div class="tl-filter">${dotHtml(filter)}<span>Showing ${seatNameHtml(filter)} only</span><button type="button" class="btn-link" id="clear-filter" data-action="clear-filter">Show everyone</button></div>`);
  } else if (pre.length) {
    parts.push(`<div class="tl-pre">${pre.map((p) => `<p>${p.html}</p>`).join("")}</div>`);
  }
  blocks.forEach((block, index) => {
    if (block.type === "card") {
      parts.push(cardHtml(block.card, { isLast: index === lastCard, running, filter }));
    } else if (!filter) {
      parts.push(`<p class="marker ${toneClass(block.described.tone)}"><span>${block.described.html}${timeTag(block.m.ts)}</span></p>`);
    }
  });
  let content;
  if (filter) {
    const spoke = blocks.some((b) => b.type === "card" && b.card.items.some((i) => i.type === "seat" && i.m.seat === filter));
    content = spoke ? parts.join("") : `${parts[0]}<p class="empty-note">${esc(nameOf(filter))} has no messages in this session.</p>`;
  } else {
    content = parts.join("") || `<p class="empty-note">Nothing recorded yet.</p>`;
  }
  preserveFocus(panel, () => {
    panel.innerHTML = `<div class="tl">${content}</div>`;
  });
  state.liveSeqs.clear();
  if (visible) measureClamps(panel);
  if (hadLive && visible) {
    if (stick) scrollToBottom();
    else if (running) els.jump.hidden = false;
  }
}

/** Long messages are clamped to 8 lines; the toggle only appears where text was actually cut. */
function measureClamps(root) {
  for (const body of root.querySelectorAll(".row-body.clamp")) {
    if (!body.offsetParent) continue;
    const clamped = body.scrollHeight > body.clientHeight + 4;
    body.classList.toggle("is-clamped", clamped);
    const button = body.nextElementSibling;
    if (button?.classList.contains("more-btn")) button.hidden = !clamped;
  }
}

// --- Seat rail and strip -----------------------------------------------------------------------

/**
 * The model a seat ran on in this session: what its provider reported answering (the truth, when
 * known), noting the configured model or alias when they differ; otherwise what it was set to.
 */
function seatModelLine(seat) {
  if (seat.adapter === "fake") return "";
  const used = seat.modelsUsed ?? [];
  const configured = seat.configuredModel;
  if (used.length) {
    const answered = used.join(", ");
    return configured && !used.includes(configured) ? `${answered} (set: ${configured})` : answered;
  }
  return configured ?? "CLI default model";
}

function seatRowsHtml(session) {
  return (session.seats ?? [])
    .map((seat) => {
      const story = seatStory(seat);
      const model = seatModelLine(seat);
      const pressed = state.seatFilter === seat.id;
      const storyHtml = [story.text ? esc(story.text) : "", story.bad ? `<span class="is-bad">${esc(story.bad)}</span>` : ""].filter(Boolean).join("; ");
      // A stable id lets focus survive the re-render every live update causes.
      return `<button type="button" class="seat-row" id="seat-row-${esc(String(seat.id).replace(/[^A-Za-z0-9_-]/g, "_"))}" data-seat="${esc(seat.id)}" aria-pressed="${pressed}">
        <span class="row-gutter">${dotHtml(seat.id)}</span>
        <span class="sr-name">${seatNameHtml(seat.id)}</span>
        <span class="sr-cost">${esc(usd(seat.spentUsd))}</span>
        <span class="sr-story">${esc(humanRole(seat.role))} ${sep} ${storyHtml}</span>
        ${model ? `<span class="sr-model">${esc(model)}</span>` : ""}
      </button>`;
    })
    .join("");
}

function renderRail() {
  const session = state.session;
  if (!session || state.sessionError) {
    const note = state.sessionError ? "No seats to show: this session couldn’t be loaded." : state.selectedId ? "Loading…" : "Select a session to see what each seat did.";
    els.railBody.innerHTML = `<p class="empty-note">${note}</p>`;
    els.railCount.textContent = "";
    els.strip.innerHTML = "";
    return;
  }
  const seats = session.seats ?? [];
  if (!seats.length) {
    els.railBody.innerHTML = `<p class="empty-note">No seats recorded for this session.</p>`;
    els.strip.innerHTML = "";
    return;
  }
  const rows = seatRowsHtml(session);
  els.railCount.textContent = String(seats.length);
  const total = Number.isFinite(Number(session.budgetCeilingUsd)) ? `${usd(session.spentUsd)} of ${usd(session.budgetCeilingUsd)}` : usd(session.spentUsd);
  preserveFocus(els.railBody, () => {
    els.railBody.innerHTML = `<div class="seat-rows">${rows}</div>
      <p class="rail-foot"><span>Total</span><span class="mono">${esc(total)}</span></p>
      <p class="rail-hint">Select a seat to show only its messages in the timeline.</p>`;
  });
  preserveFocus(els.strip, () => {
    els.strip.innerHTML = rows;
  });
}

function setSeatFilter(seatId) {
  state.seatFilter = state.seatFilter === seatId ? null : seatId;
  for (const row of document.querySelectorAll(".seat-row")) row.setAttribute("aria-pressed", String(row.dataset.seat === state.seatFilter));
  if (state.tab !== "timeline") setTab("timeline");
  else renderTimeline();
  announce(state.seatFilter ? `Timeline shows ${nameOf(state.seatFilter)} only.` : "Timeline shows every seat.");
}

// ---------------------------------------------------------------------------------------------
// Tabs

function applyTab() {
  for (const name of TABS) {
    const selected = name === state.tab;
    els.tabs[name].setAttribute("aria-selected", String(selected));
    els.tabs[name].tabIndex = selected ? 0 : -1;
    els.panels[name].hidden = !selected;
  }
  els.jump.hidden = true;
}

function setTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) return;
  state.tab = name;
  applyTab();
  if (name === "timeline") {
    renderTimeline();
    measureClamps(els.panels.timeline);
  }
  // Keep the tab bar where it is: if the header had scrolled away, start the new panel at its top.
  if (!isNarrow()) {
    const top = els.tabsBar.offsetTop;
    if (els.sessionPanel.scrollTop > top) els.sessionPanel.scrollTop = top;
  }
  if (focus) els.tabs[name].focus();
}

// ---------------------------------------------------------------------------------------------
// Actions

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

async function runAction(action, button) {
  const id = state.selectedId;
  const session = state.session;
  if (!id || !session) return;
  switch (action) {
    case "goto-tab":
      setTab(button.dataset.tab, { focus: true });
      return;
    case "toggle-task": {
      state.taskOpen = !state.taskOpen;
      button.setAttribute("aria-expanded", String(state.taskOpen));
      button.textContent = state.taskOpen ? "Hide full task" : "Show full task";
      $("full-task").hidden = !state.taskOpen;
      return;
    }
    case "copy-branch":
    case "copy-diff": {
      if (!session.branch) return;
      const text = action === "copy-branch" ? session.branch : `git diff HEAD...${session.branch}`;
      const ok = await copyText(text);
      showToast(ok ? (action === "copy-branch" ? "Branch name copied" : "Diff command copied") : "Couldn’t copy. Your browser blocked the clipboard.");
      return;
    }
    case "stop":
      state.confirmStop = true;
      state.confirmAt = Date.now();
      renderHeader();
      $("action-stop-confirm")?.focus();
      return;
    case "stop-cancel":
      state.confirmStop = false;
      renderHeader();
      $("action-stop")?.focus();
      return;
    case "stop-confirm": {
      if (Date.now() - state.confirmAt < 350) return; // a double click must not confirm
      state.confirmStop = false;
      state.stopRequested = true;
      renderHeader();
      focusHeader();
      try {
        await postJson(sessionPath(id, "/cancel"));
        showNotice("Stop requested. The run stops at its next checkpoint; the worktree is kept.", "neutral");
        announce("Stop requested.");
      } catch (error) {
        state.stopRequested = false;
        renderHeader();
        showNotice(error.status === 409 ? "The run had already finished." : `Couldn’t stop the run: ${error.message}`, "danger");
      }
      await Promise.all([refreshSessions(), loadDetail()]);
      return;
    }
    case "resume": {
      button.disabled = true;
      // The operator may open another session while the request is in flight; everything after
      // the await belongs to this session's view only.
      const token = state.token;
      const stillHere = () => token === state.token && id === state.selectedId;
      try {
        await postJson(sessionPath(id, "/resume"));
        if (stillHere()) {
          showNotice("Resumed. Progress appears in the timeline.", "info");
          announce("The council resumed.");
          setTab("timeline");
          if (!state.eventSource || state.eventSource.readyState === EventSource.CLOSED) connectEvents(id, token);
        }
      } catch (error) {
        if (stillHere()) {
          showNotice(error.status === 409 ? "A council is already in session. One run at a time." : `Couldn’t resume: ${error.message}`, "danger");
          button.disabled = false;
        }
      }
      if (!stillHere()) {
        refreshSessions();
        return;
      }
      await Promise.all([refreshSessions(), loadDetail()]);
      setTimeout(() => {
        if (id !== state.selectedId) return;
        state.sessionJson = ""; // force a re-render so the buttons reflect the real state
        loadDetail();
        catchUpMessages();
      }, 1_500);
      return;
    }
    case "apply-preview": {
      button.disabled = true;
      state.applyError = null;
      try {
        const result = await postJson(sessionPath(id, "/apply"), { check: true });
        state.applyPreview = { sessionId: id, files: result?.files ?? [] };
      } catch (error) {
        if (error.status === 409) state.applyError = { sessionId: id, message: error.message };
        else showNotice(`Couldn’t check the folder: ${error.message}`, "danger");
      }
      renderHeader();
      focusHeader($("action-apply-confirm") ?? $("action-apply"));
      return;
    }
    case "apply-cancel":
      state.applyPreview = null;
      state.applyError = null;
      renderHeader();
      $("action-apply")?.focus();
      return;
    case "apply-confirm": {
      button.disabled = true;
      try {
        const result = await postJson(sessionPath(id, "/apply"), { check: false });
        const count = (result?.files ?? []).length;
        state.applyPreview = null;
        showNotice(`Applied ${plural(count, "change")} to the folder.`, "success");
        announce("Changes applied to the folder.");
      } catch (error) {
        state.applyPreview = null;
        if (error.status === 409) state.applyError = { sessionId: id, message: error.message };
        else showNotice(`Couldn’t apply: ${error.message}`, "danger");
      }
      state.sessionJson = "";
      await loadDetail();
      focusHeader();
      return;
    }
    case "goto-ruling":
      focusRuling(button.dataset.cid);
      return;
    case "clear-filter":
      setSeatFilter(state.seatFilter);
      $("tab-timeline")?.focus();
      return;
    default:
  }
}

/**
 * After an action re-renders the header, focus must land somewhere on purpose rather than drop to
 * the page body: the preferred control if it exists, else the header's first control, else the panel.
 */
function focusHeader(preferred) {
  const target = preferred ?? els.header.querySelector("button:not([disabled]), textarea, [href]");
  if (target) target.focus();
  else els.sessionPanel.focus({ preventScroll: true });
}

/** Element ids for one contention's ruling form. Contention ids are "c-" plus hex, safe in an id. */
const rulingBase = (contentionId) => `ruling-${String(contentionId).replace(/[^A-Za-z0-9_-]/g, "_")}`;

function focusRuling(contentionId) {
  const field = (contentionId && $(`${rulingBase(contentionId)}-reason`)) || document.querySelector(".ruling-form textarea");
  if (!field) return;
  const scroller = isNarrow() ? document.scrollingElement : els.sessionPanel;
  scroller.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  field.focus({ preventScroll: true });
}

async function submitRuling(form, ruling) {
  const sessionId = state.selectedId;
  const contentionId = form.dataset.cid;
  const textarea = form.querySelector("textarea");
  const errorEl = form.querySelector(".field-error");
  const buttons = [...form.querySelectorAll("button")];
  const reasoning = textarea.value.trim();
  if (ruling !== "UPHELD" && ruling !== "DISMISSED") return;
  if (!reasoning) {
    errorEl.textContent = "A reason is required. The council reads it in later rounds.";
    errorEl.hidden = false;
    textarea.setAttribute("aria-invalid", "true");
    textarea.focus();
    return;
  }
  errorEl.hidden = true;
  for (const button of buttons) button.disabled = true;
  try {
    const result = await postJson(sessionPath(sessionId, `/contentions/${encodeURIComponent(contentionId)}/ruling`), { ruling, reasoning });
    state.rulingDrafts.delete(contentionId);
    const remaining = Array.isArray(result?.awaitingHumanRuling) ? result.awaitingHumanRuling.length : 0;
    const verb = ruling === "UPHELD" ? "upheld" : "dismissed";
    announce(remaining ? `Ruling recorded: objection ${verb}. ${plural(remaining, "ruling")} left.` : `Ruling recorded: objection ${verb}. Every dispute is settled; resume when ready.`);
    await Promise.all([loadDetail(), refreshSessions()]);
    if (remaining === 0) $("action-resume")?.focus();
    else document.querySelector(".ruling-form textarea")?.focus();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
    for (const button of buttons) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Dialogs: native modal <dialog> plus an explicit Tab trap and focus return

function focusables(root) {
  return [...root.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.disabled && !el.hidden && el.getAttribute("aria-hidden") !== "true" && el.offsetParent !== null,
  );
}

function openDialog(dialog, opener, focusTarget) {
  state.dialogReturn.set(dialog, opener ?? document.activeElement);
  if (!dialog.open) dialog.showModal();
  (focusTarget ?? focusables(dialog)[0])?.focus();
}

function wireDialog(dialog, { canDismiss = () => true, onClose = () => {}, onKeptOpen = () => {} } = {}) {
  // Esc gets the same unsaved-changes guard as a backdrop click. It is stopped at keydown: the
  // dialog's own "cancel" event can only be prevented after fresh user activation, so it is just
  // the fallback.
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || canDismiss()) return;
    event.preventDefault();
    onKeptOpen();
  });
  dialog.addEventListener("cancel", (event) => {
    if (canDismiss()) return;
    event.preventDefault();
    onKeptOpen();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const items = focusables(dialog);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-close]")) {
      dialog.close();
      return;
    }
    // A click on the backdrop lands on the dialog element itself, outside its content box.
    if (event.target === dialog && canDismiss()) {
      const rect = dialog.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    onClose();
    const target = state.dialogReturn.get(dialog);
    state.dialogReturn.delete(dialog);
    if (target && document.contains(target)) target.focus();
  });
}

// --- New council -------------------------------------------------------------------------------

function showBusyTip(show) {
  els.newCouncilTip.hidden = !(show && state.busy);
}

function openNewCouncil(opener) {
  if (state.busy) {
    showBusyTip(true);
    announce("A council is already in session. One run at a time.");
    return;
  }
  els.ncError.hidden = true;
  els.ncTask.removeAttribute("aria-invalid");
  els.ncCwd.removeAttribute("aria-invalid");
  state.councilModels = new Map();
  forgetCustomPicks("council:");
  // "Run anyway" is consent for one council on one folder; every new council asks again.
  els.ncDirty.checked = false;
  state.dirtyConsentPath = null;
  renderCouncilModels();
  closeFolderBrowser();
  openDialog(els.ncDialog, opener, els.ncTask);
  loadRecentRepos();
  inspectRepo();
  loadSeats().then(() => {
    renderCouncilModels();
    for (const seat of councilModelSeats()) loadCatalog(seat.id);
  });
}

/** Seats whose model can be switched for one council: enabled, and backed by a real provider. */
function councilModelSeats() {
  return (state.seatConfig?.seats ?? []).filter((seat) => seat.enabled !== false && (seat.adapter === "cli" || seat.adapter === "xenia"));
}

function renderCouncilModels() {
  const seats = councilModelSeats();
  const overrides = state.councilModels ?? new Map();
  els.ncModelsSummary.textContent = overrides.size ? `${plural(overrides.size, "seat")} switched for this council` : "Each seat’s saved model";
  if (!seats.length) {
    els.ncModelsBody.innerHTML = `<p class="help">No seat here has a model to switch.</p>`;
    return;
  }
  preserveFocus(els.ncModelsBody, () => {
    els.ncModelsBody.innerHTML = seats
      .map((seat, index) => {
        const id = `ncm-${index}`;
        const saved = seat.adapter === "xenia" ? seat.xeniaModel : seat.cliModel;
        return `<div class="ncm-row" data-council-model="${esc(seat.id)}">
          <label class="label" for="${id}">${esc(seat.label || seat.id)}</label>
          ${modelPickerHtml({
            key: `council:${seat.id}`,
            seatId: seat.id,
            id,
            value: overrides.get(seat.id) ?? "",
            defaultLabel: saved ? `Saved model · ${saved}` : `Saved model · ${cliDefaultLabel(seat.id)}`,
            describedBy: `${id}-help`,
            name: seat.label || seat.id,
          })}
          <p class="help" id="${id}-help">${catalogHelpHtml(seat, overrides.get(seat.id) ?? "")}</p>
        </div>`;
      })
      .join("");
  });
}

// --- Repository picker --------------------------------------------------------------------------

/** Recently used repositories become suggestions, and the default when nothing was entered yet. */
async function loadRecentRepos() {
  try {
    const { repos } = await api("/api/repos/recent");
    els.ncRecent.innerHTML = (repos ?? []).map((repo) => `<option value="${esc(repo.path)}" label="${esc(repo.name)}"></option>`).join("");
    if (!els.ncCwd.value.trim() && repos?.length) {
      els.ncCwd.value = repos[0].path;
      inspectRepo();
    }
  } catch {
    // Suggestions are a convenience; typing or browsing still works.
  }
}

let inspectTimer = null;
let inspectSeq = 0;

/** Says what the entered folder is — before Convene, not as a failed session afterwards. */
function inspectRepo({ debounce = false } = {}) {
  clearTimeout(inspectTimer);
  const run = async () => {
    const path = els.ncCwd.value.trim();
    const seq = ++inspectSeq;
    if (!path) {
      state.repo = null;
      renderRepoStatus();
      return;
    }
    try {
      const info = await api(`/api/fs/repo?path=${encodeURIComponent(path)}`);
      if (seq === inspectSeq) state.repo = info;
    } catch (error) {
      if (seq === inspectSeq) state.repo = { error: error.message };
    }
    if (seq === inspectSeq) renderRepoStatus();
  };
  if (debounce) inspectTimer = setTimeout(run, 300);
  else run();
}

function renderRepoStatus() {
  const repo = state.repo;
  const status = els.ncRepoStatus;
  let tone = "";
  let text = "";
  let dirty = false;
  if (!repo) text = "";
  else if (repo.error) [tone, text] = ["danger", `Couldn’t check that folder: ${repo.error}`];
  else if (!repo.exists) [tone, text] = ["danger", "That folder doesn’t exist."];
  else if (!repo.isDirectory) [tone, text] = ["danger", "That’s a file, not a folder."];
  else if (repo.kind === "folder") {
    const name = String(repo.path).split(/[\\/]/).filter(Boolean).at(-1) ?? repo.path;
    const what = !repo.isGitRepo ? "plain folder, not a git repository" : repo.head ? "not tracked by the git repository around it" : "git repository with no commits yet";
    [tone, text] = ["info", `${name} · ${what}`];
  } else {
    const name = String(repo.root).split(/[\\/]/).filter(Boolean).at(-1) ?? repo.root;
    const where = repo.root !== repo.path ? ` (runs on the whole repository, ${name})` : "";
    if (repo.changes > 0) {
      dirty = true;
      [tone, text] = ["warning", `${name} · ${repo.branch} · ${plural(repo.changes, "uncommitted change")}${where}.`];
    } else {
      [tone, text] = ["success", `✓ ${name} · ${repo.branch} at ${repo.head} · clean${where}`];
    }
  }
  status.textContent = text;
  status.className = `repo-status${tone ? ` tone-text tone-${tone}` : ""}`;
  els.ncNote.innerHTML =
    repo?.kind === "folder"
      ? "Runs on a private snapshot of the folder. Seats approve or dispute; your folder changes only when you apply the ratified result."
      : `Runs on an isolated ${code("conclave/<id>")} branch in your repository. Seats approve or dispute; nothing is merged.`;
  els.ncDirtyWrap.hidden = !dirty;
  // Consent to run on uncommitted changes is given for one folder, never carried to another.
  if (!dirty || repo?.path !== state.dirtyConsentPath) els.ncDirty.checked = false;
  state.dirtyConsentPath = dirty ? repo.path : null;
}

async function browseTo(path) {
  els.ncFbList.innerHTML = `<li class="help">Loading…</li>`;
  try {
    state.browser = await api(`/api/fs/dirs?path=${encodeURIComponent(path || "~")}`);
  } catch (error) {
    els.ncFbList.innerHTML = `<li class="field-error">${esc(error.message)}</li>`;
    return;
  }
  const listing = state.browser;
  // The path box truncates from the left (direction: rtl) so the folder name stays visible; a leading
  // left-to-right mark keeps the path's own slashes from being reordered by that.
  els.ncFbPath.textContent = `\u200E${listing.path}`;
  els.ncFbPath.title = listing.path;
  els.ncFbUse.disabled = false;
  els.ncFbHint.textContent = listing.isGitRepo ? "This folder is a git repository." : "Any folder works. Git repositories are marked.";
  els.ncBrowser.querySelector('[data-fb="up"]').disabled = !listing.parent;
  els.ncFbList.innerHTML = listing.entries.length
    ? listing.entries
        .map((entry) => `<li><button type="button" class="fb-item" data-fb-path="${esc(entry.path)}"><span class="fb-name">${esc(entry.name)}</span>${entry.isGitRepo ? badge("git", "success") : ""}</button></li>`)
        .join("") + (listing.truncated ? `<li class="help">Only the first 500 folders are shown.</li>` : "")
    : `<li class="help">No folders here.</li>`;
}

function openFolderBrowser() {
  els.ncBrowser.hidden = false;
  els.ncBrowse.setAttribute("aria-expanded", "true");
  const typed = els.ncCwd.value.trim();
  const start = state.repo?.isDirectory ? state.repo.path : typed || "~";
  browseTo(start).then(() => els.ncFbList.querySelector("button")?.focus());
}

function closeFolderBrowser() {
  els.ncBrowser.hidden = true;
  els.ncBrowse.setAttribute("aria-expanded", "false");
}

const CWD_ERRORS = {
  "cwd does not exist or is not accessible": "That folder doesn’t exist or isn’t accessible.",
  "cwd is not a directory": "That path isn’t a folder.",
  "cwd is not a git repository": "That folder isn’t a git repository.",
  "cwd repository has no commits yet": "That repository has no commits yet.",
  "message is required": "Describe the task first.",
};

async function convene(event) {
  event.preventDefault();
  if (els.ncSubmit.disabled) return;
  const message = els.ncTask.value.trim();
  const cwd = els.ncCwd.value.trim();
  if (!cwd) {
    els.ncError.textContent = "Choose a folder first.";
    els.ncError.hidden = false;
    els.ncCwd.setAttribute("aria-invalid", "true");
    els.ncCwd.focus();
    return;
  }
  if (!message) {
    els.ncError.textContent = "Describe the task first.";
    els.ncError.hidden = false;
    els.ncTask.setAttribute("aria-invalid", "true");
    els.ncTask.focus();
    return;
  }
  els.ncError.hidden = true;
  els.ncSubmit.disabled = true;
  els.ncSubmit.textContent = "Convening…";
  try {
    const models = Object.fromEntries([...(state.councilModels ?? new Map())].filter(([, model]) => model.trim()));
    const request = { message, cwd };
    if (Object.keys(models).length) request.models = models;
    if (els.ncDirty.checked && !els.ncDirtyWrap.hidden) request.allowDirtySource = true;
    const result = await postJson("/api/chat", request);
    writeStorage("conclave.cwd", cwd);
    els.ncTask.value = "";
    els.ncDialog.close();
    await refreshSessions();
    if (result?.sessionId) await selectSession(result.sessionId, { tab: "timeline" });
    announce("Council convened.");
  } catch (error) {
    let text;
    if (error.status === 409) text = "A council is already in session. One run at a time.";
    else if (error.status === 429) text = `${capitalize(tidy(error.message))}. New councils can start once spend in that window drops below the limit.`;
    else if (/^cwd has uncommitted changes/.test(error.message)) text = `${capitalize(error.message.replace(/^cwd has/, "That repository has"))}. Commit or stash them, or tick “Run anyway”.`;
    else text = CWD_ERRORS[error.message] ?? capitalize(error.message);
    els.ncError.textContent = text;
    els.ncError.hidden = false;
    if (/^cwd/.test(error.message)) {
      els.ncCwd.setAttribute("aria-invalid", "true");
      els.ncCwd.focus();
    }
  } finally {
    els.ncSubmit.textContent = "Convene";
    els.ncSubmit.disabled = state.busy;
  }
}

// --- Council settings --------------------------------------------------------------------------

function healthInfo(seatId) {
  if (state.authLoading) return { label: "Checking…", tone: "neutral" };
  const status = state.auth.get(seatId);
  if (!status || status.unchecked) return { label: "Not checked", tone: "neutral" };
  if (status.healthy) return { label: "Ready", tone: "success", detail: status.detail };
  if (!status.binaryFound) return { label: "Missing", tone: "warning", detail: status.detail, hint: status.loginHint };
  return { label: "Failing", tone: "danger", detail: status.detail, hint: status.loginHint };
}

function renderSettingsDot() {
  const seats = state.seatConfig?.seats ?? [];
  const troubled = seats.some((seat) => seat.enabled !== false && ["Missing", "Failing"].includes(healthInfo(seat.id).label));
  els.settingsDot.hidden = !(state.seatConfig?.problem || troubled);
  els.openSettings.setAttribute("aria-label", els.settingsDot.hidden ? "Council settings" : "Council settings (needs attention)");
}

function settingsDirty() {
  const s = state.settings;
  if (!s?.draft) return false;
  return s.draft.some((seat) => {
    const original = s.original.get(seat.id);
    return original && (original.enabled !== seat.enabled || original.cliModel !== seat.cliModel || original.xeniaModel !== seat.xeniaModel);
  });
}

function healthHeaderHtml() {
  let text;
  if (state.authLoading) text = "Checking seat health…";
  else if (state.authError) text = `Health check failed: ${state.authError}`;
  else if (state.authCheckedAt) text = `Health checked at ${clock(toDate(state.authCheckedAt) ?? new Date())}`;
  else if ((state.seatConfig?.seats ?? []).some((seat) => seat.adapter === "cli")) text = "CLI seats not checked yet";
  else text = "Checked on load";
  const stale = state.authStale && !state.authLoading ? ` ${badge("Stale", "warning")}` : "";
  return `<div class="set-health">
    <div class="set-health-text"><p>${esc(text)}${stale}</p><p class="help">Recheck runs one small billed call per CLI seat.</p></div>
    <button type="button" class="btn small" id="recheck-health" data-action="recheck"${state.authLoading ? " disabled" : ""}>${state.authLoading ? "Checking…" : "Recheck health"}</button>
  </div>`;
}

// --- Model catalogs ------------------------------------------------------------------------------

/** Loads (once) what a seat can be switched to; settings and New council share the result. */
async function loadCatalog(seatId) {
  if (state.catalogs.has(seatId)) return;
  state.catalogs.set(seatId, { loading: true });
  try {
    state.catalogs.set(seatId, await api(`/api/seats/${encodeURIComponent(seatId)}/models`));
  } catch (error) {
    state.catalogs.set(seatId, { error: error.message, models: [] });
  }
  if (state.settings?.draft && els.stDialog.open) renderSettings();
  if (els.ncDialog.open) renderCouncilModels();
}

/** The picker's "type any id" choice; no provider names a model this. */
const CUSTOM_MODEL = "(custom)";

/** Pickers left on "Custom id…" before anything is typed, so a re-render keeps them there. */
const customModelPicks = new Set();

const forgetCustomPicks = (prefix) => {
  for (const key of customModelPicks) if (key.startsWith(prefix)) customModelPicks.delete(key);
};

const modelOptionText = (model) => (model.label && model.label !== model.id ? `${model.label} · ${model.id}` : model.id);

/** A catalog's models, grouped by their stated group or, in a long gateway list, by `provider/` prefix. */
function modelGroups(models) {
  const byPrefix = models.length > 30 && models.some((model) => model.id.includes("/"));
  const groups = new Map();
  for (const model of models) {
    const key = model.group ?? (byPrefix && model.id.includes("/") ? model.id.split("/")[0] : "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  }
  return groups;
}

/**
 * A model picker: every catalog model in a real select, whatever is currently chosen (a text field
 * with suggestions hides them all once it holds a value), plus "Custom id…" for any id the provider
 * accepts that the catalog doesn't list. `value` is "" for `defaultLabel`.
 */
function modelPickerHtml({ key, seatId, id, value, defaultLabel, describedBy, name, trailing = "" }) {
  const catalog = state.catalogs.get(seatId);
  const models = catalog?.models ?? [];
  const loaded = Boolean(catalog && !catalog.loading);
  const listed = models.some((model) => model.id === value);
  // Until the list arrives, show the current id as it is rather than as a custom one.
  const custom = customModelPicks.has(key) || (loaded && value !== "" && !listed);
  const selected = custom ? CUSTOM_MODEL : value;
  const option = (optionValue, text) => `<option value="${esc(optionValue)}"${optionValue === selected ? " selected" : ""}>${esc(text)}</option>`;
  const groups = modelGroups(models);
  const listHtml = [...groups]
    .map(([group, entries]) => {
      const options = entries.map((model) => option(model.id, modelOptionText(model))).join("");
      return group && groups.size > 1 ? `<optgroup label="${esc(group)}">${options}</optgroup>` : options;
    })
    .join("");
  const pending = !loaded && value && !custom ? option(value, value) : "";
  return `<div class="model-field" data-model-key="${esc(key)}">
    <div class="model-pick">
      <span class="select"><select id="${esc(id)}" aria-describedby="${esc(describedBy)}">${option("", defaultLabel)}${pending}${listHtml}${option(CUSTOM_MODEL, "Custom id…")}</select></span>
      ${trailing}
    </div>
    <input type="text" class="model-custom" id="${esc(id)}-custom" data-model-custom value="${esc(custom ? value : "")}" placeholder="Model id" aria-label="${esc(`Custom model id for ${name}`)}" autocomplete="off" spellcheck="false"${custom ? "" : " hidden"}>
  </div>`;
}

/**
 * Reads a picker after an edit: the chosen id, "" for its default, or the typed custom id. Choosing
 * "Custom id…" opens and focuses the text field; choosing anything else closes and clears it.
 */
function readModelPick(field, target) {
  const select = field.querySelector("select");
  const custom = field.querySelector("[data-model-custom]");
  const isCustom = select.value === CUSTOM_MODEL;
  if (isCustom) customModelPicks.add(field.dataset.modelKey);
  else customModelPicks.delete(field.dataset.modelKey);
  if (target === select) {
    if (isCustom) {
      custom.hidden = false;
      custom.focus();
    } else {
      custom.hidden = true;
      custom.value = "";
    }
  }
  return isCustom ? custom.value.trim() : select.value;
}

/** Where a seat's model list came from, what "default" means, and whether the typed id is listed. */
function catalogHelpHtml(seat, value) {
  const catalog = state.catalogs.get(seat.id);
  if (!catalog || catalog.loading) return "Loading available models…";
  if (catalog.error && !(catalog.models ?? []).length) return esc(`Couldn’t list models: ${tidy(catalog.error)}. You can still type an id.`);
  const parts = [];
  const count = (catalog.models ?? []).length;
  if (count) parts.push(esc(`${plural(count, "model")} from ${catalog.source}.${catalog.authoritative ? "" : " For any other id the CLI accepts, choose Custom id…"}`));
  const typed = String(value ?? "").trim();
  if (typed && catalog.authoritative && !(catalog.models ?? []).some((model) => model.id === typed)) {
    parts.push(`<span class="tone-text tone-warning">${esc(`Not listed by ${catalog.source}; test it before saving.`)}</span>`);
  }
  return parts.join(" ") || esc(catalog.note ?? "");
}

/** "CLI default", naming what that resolves to when the CLI's config says. */
function cliDefaultLabel(seatId) {
  const resolved = state.catalogs.get(seatId)?.defaultModel;
  return resolved ? `CLI default (${resolved})` : "CLI default";
}

function modelTestHtml(test) {
  if (!test || test.running) return test?.running ? `<p class="help" role="status">Making one small billed call…</p>` : "";
  const result = test.result;
  const who = result.model ?? "default model";
  const answered = result.answeredBy && result.answeredBy !== result.model ? ` (answered by ${result.answeredBy})` : "";
  return result.healthy
    ? `<p class="help tone-text tone-success" role="status">${esc(`✓ ${who}${answered} responded.`)}</p>`
    : `<p class="help tone-text tone-danger" role="status">${esc(`✗ ${who}: ${tidy(result.detail ?? "no response")}`)}</p>`;
}

async function testModel(seatId) {
  const s = state.settings;
  const seat = s?.draft?.find((entry) => entry.id === seatId);
  if (!seat || s.tests.get(seatId)?.running) return;
  const field = seat.adapter === "xenia" ? "xeniaModel" : "cliModel";
  s.tests.set(seatId, { running: true });
  renderSettings();
  try {
    const result = await postJson(`/api/seats/${encodeURIComponent(seatId)}/test`, { model: seat[field].trim() || null });
    if (state.settings === s) s.tests.set(seatId, { result });
  } catch (error) {
    if (state.settings === s) s.tests.set(seatId, { result: { healthy: false, detail: error.message, model: seat[field].trim() || undefined } });
  }
  if (state.settings === s) renderSettings();
}

function settingsSeatHtml(seat, index) {
  const base = `set-${index}`;
  const locked = seat.id === "claude";
  const modelField = seat.adapter === "cli" ? "cliModel" : seat.adapter === "xenia" ? "xeniaModel" : null;
  const health = healthInfo(seat.id);
  const error = state.settings.rowErrors.get(seat.id);
  const adapter = seat.adapter === "cli" ? `CLI${seat.cliCommand ? ` (${seat.cliCommand})` : ""}` : seat.adapter === "xenia" ? "Xenia gateway" : seat.adapter === "fake" ? "In-process fake" : String(seat.adapter ?? "");
  const switchHtml = `<button type="button" class="switch" role="switch" id="${base}-enabled" data-toggle="${esc(seat.id)}" aria-checked="${seat.enabled}" aria-labelledby="${base}-name"${locked ? ` aria-disabled="true" aria-describedby="${base}-lock"` : ""}></button>`;
  const test = state.settings.tests.get(seat.id);
  const model = modelField
    ? `<div class="set-model" data-model="${esc(seat.id)}" data-field="${modelField}"><label class="label" for="${base}-model">Model</label>
        ${modelPickerHtml({
          key: `settings:${seat.id}`,
          seatId: seat.id,
          id: `${base}-model`,
          value: seat[modelField] ?? "",
          defaultLabel: seat.adapter === "xenia" ? "Choose a model…" : cliDefaultLabel(seat.id),
          describedBy: `${base}-model-help`,
          name: seat.label || seat.id,
          trailing: `<button type="button" class="btn small" id="${base}-test" data-action="test-model" data-seat="${esc(seat.id)}"${test?.running ? " disabled" : ""}>${test?.running ? "Testing…" : "Test"}</button>`,
        })}
      </div>
      <p class="help model-help" id="${base}-model-help">${catalogHelpHtml(seat, seat[modelField] ?? "")}</p>
      ${modelTestHtml(test)}`
    : "";
  const commandLike = /^[\w./@-]+(?: [\w./@-]+){0,3}$/.test(String(health.hint ?? ""));
  const hint = health.hint ? `Fix: ${commandLike ? code(health.hint) : esc(`${capitalize(health.hint)}.`)}` : "";
  const detail = [health.detail && health.label !== "Ready" ? esc(`${capitalize(tidy(health.detail))}.`) : "", hint].filter(Boolean).join(" ");
  return `<li class="set-seat${seat.enabled ? "" : " is-off"}">
    <span class="row-gutter">${dotHtml(seat.id)}</span>
    <div><p class="set-name" id="${base}-name">${seatNameHtml(seat.id)}</p><p class="set-sub">${esc(humanRole(seat.role))} ${sep} ${esc(adapter)}</p></div>
    <div class="set-switch">${switchHtml}</div>
    <div class="set-extra">
      ${model}
      ${locked ? `<p class="set-line" id="${base}-lock">Always on: Claude plans, executes and remediates every change.</p>` : ""}
      <p class="set-line">${badge(health.label, health.tone)}${detail ? `<span>${detail}</span>` : ""}</p>
      ${error ? `<p class="field-error" role="alert">${esc(error)}</p>` : ""}
    </div>
  </li>`;
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  if (!s.draft) {
    els.stBody.innerHTML = s.loadError ? `<p class="banner tone-danger" role="alert">${esc(s.loadError)}</p>` : `<p class="loading">Loading seats…</p>`;
    els.stSave.disabled = true;
    return;
  }
  const problem = state.seatConfig?.problem ? `<p class="banner tone-warning" role="alert">Seat configuration problem: ${esc(state.seatConfig.problem)}</p>` : "";
  preserveFocus(els.stBody, () => {
    els.stBody.innerHTML = `${problem}${healthHeaderHtml()}<ul class="set-seats">${s.draft.map(settingsSeatHtml).join("")}</ul>`;
  });
  els.stSave.disabled = s.saving || !settingsDirty();
}

async function openSettings(opener) {
  state.settings = { draft: null, original: new Map(), saving: false, rowErrors: new Map(), loadError: null, tests: new Map() };
  forgetCustomPicks("settings:");
  els.stStatus.textContent = "";
  els.stStatus.className = "sheet-status";
  renderSettings();
  openDialog(els.stDialog, opener, els.stDialog.querySelector("[data-close]"));
  // The sheet can be closed (and reopened) while the seats load; only this opening's state is ours.
  const s = state.settings;
  try {
    state.seatConfig = await api("/api/seats");
    for (const seat of state.seatConfig.seats ?? []) registerSeat(seat.id, seat.label);
  } catch (error) {
    if (state.settings !== s) return;
    if (!state.seatConfig) {
      s.loadError = `Could not load seats: ${error.message}`;
      renderSettings();
      return;
    }
  }
  if (state.settings !== s) return;
  const seats = (state.seatConfig?.seats ?? []).map((seat) => ({ id: seat.id, label: seat.label, role: seat.role, adapter: seat.adapter, cliCommand: seat.cliCommand, enabled: seat.enabled !== false, cliModel: seat.cliModel ?? "", xeniaModel: seat.xeniaModel ?? "" }));
  s.draft = seats;
  s.original = new Map(seats.map((seat) => [seat.id, { ...seat }]));
  renderSettings();
  for (const seat of seats) if (seat.adapter === "cli" || seat.adapter === "xenia") loadCatalog(seat.id);
}

async function saveSettings() {
  const s = state.settings;
  if (!s?.draft || s.saving || !settingsDirty()) return;
  s.saving = true;
  s.rowErrors = new Map();
  els.stSave.disabled = true;
  els.stSave.textContent = "Saving…";
  els.stStatus.textContent = "";
  let snapshot = null;
  try {
    for (const seat of s.draft) {
      const original = s.original.get(seat.id);
      if (!original) continue;
      const patch = { id: seat.id };
      if (original.enabled !== seat.enabled) patch.enabled = seat.enabled;
      if (original.cliModel !== seat.cliModel) patch.cliModel = seat.cliModel.trim() || null;
      if (original.xeniaModel !== seat.xeniaModel) patch.xeniaModel = seat.xeniaModel.trim() || null;
      if (Object.keys(patch).length === 1) continue;
      try {
        snapshot = await api("/api/seats", { method: "PUT", body: JSON.stringify(patch) });
      } catch (error) {
        const message = /xenia seat needs a xeniaModel/.test(error.message) ? "A Xenia seat can’t run without a model." : capitalize(error.message);
        s.rowErrors.set(seat.id, message);
        throw new Error(message);
      }
      s.original.set(seat.id, { ...seat });
    }
    // A successful save rewrites the config file, which clears any load problem server-side.
    if (snapshot) state.seatConfig = { ...snapshot, problem: undefined };
    s.saving = false;
    els.stDialog.close();
    showToast("Settings saved. They apply to new councils.");
    loadAuth(false);
  } catch (error) {
    s.saving = false;
    if (snapshot) state.seatConfig = { ...snapshot, problem: undefined };
    els.stStatus.textContent = `Not saved: ${error.message}`;
    els.stStatus.className = "sheet-status tone-text tone-danger";
    renderSettings();
  } finally {
    els.stSave.textContent = "Save";
  }
}

async function loadSeats() {
  try {
    state.seatConfig = await api("/api/seats");
    for (const seat of state.seatConfig.seats ?? []) registerSeat(seat.id, seat.label);
  } catch {
    // Settings shows the error when opened; nothing on the page depends on this.
  }
  renderSettingsDot();
}

/** Only an explicit Recheck probes CLI seats: each probe is a billed model call. */
async function loadAuth(refresh) {
  state.authLoading = true;
  if (state.settings?.draft) renderSettings();
  try {
    // Only a POST re-probes (a billed call per CLI seat); a GET returns the last result.
    const result = await api("/api/auth/status", refresh ? { method: "POST" } : {});
    state.auth = new Map((result?.seats ?? []).map((status) => [status.seat, status]));
    state.authCheckedAt = result?.checkedAt ?? null;
    state.authStale = !!result?.stale;
    state.authError = null;
  } catch (error) {
    state.authError = error.message;
  } finally {
    state.authLoading = false;
    if (state.settings?.draft && els.stDialog.open) renderSettings();
    renderSettingsDot();
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring

function isTypingTarget(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

function wire() {
  // The skip link moves focus without touching the URL hash, which holds the selected session.
  document.querySelector(".skip-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    els.sessionPanel.focus({ preventScroll: isNarrow() ? false : true });
  });

  // Top bar
  els.newCouncil.addEventListener("click", () => openNewCouncil(els.newCouncil));
  els.welcomeNew.addEventListener("click", () => openNewCouncil(els.welcomeNew));
  for (const event of ["mouseenter", "focus"]) els.newCouncil.addEventListener(event, () => showBusyTip(true));
  for (const event of ["mouseleave", "blur"]) els.newCouncil.addEventListener(event, () => showBusyTip(false));
  els.openSettings.addEventListener("click", () => openSettings(els.openSettings));

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") showBusyTip(false);
    if ((event.key === "n" || event.key === "N") && !isTypingTarget(event.target) && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      openNewCouncil(document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : els.newCouncil);
    }
  });

  // Session list
  els.sessionListBody.addEventListener("click", (event) => {
    const item = event.target.closest("button[data-id]");
    if (!item) return;
    if (isNarrow()) {
      state.listOpen = false;
      applyListOpen();
    }
    if (item.dataset.id !== state.selectedId) selectSession(item.dataset.id);
    if (isNarrow()) els.sessionPanel.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  });
  els.loadMore.addEventListener("click", () => {
    state.sessionPages += 1;
    refreshSessions();
  });
  els.toggleSessions.addEventListener("click", () => {
    state.listOpen = !state.listOpen;
    applyListOpen();
  });

  // Session view: header actions, rulings, tabs, timeline controls
  els.view.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action && els.view.contains(action)) {
      runAction(action.dataset.action, action);
      return;
    }
    const toggle = event.target.closest(".tl-toggle");
    if (toggle) {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(open));
      state.cardOpen.set(toggle.dataset.card, open);
      const body = $(toggle.getAttribute("aria-controls"));
      if (body) {
        body.hidden = !open;
        if (open) measureClamps(body);
      }
      return;
    }
    const more = event.target.closest("[data-more]");
    if (more) {
      const seq = Number(more.dataset.more);
      const body = $(more.getAttribute("aria-controls"));
      const expand = !state.expandedMsgs.has(seq);
      if (expand) state.expandedMsgs.add(seq);
      else state.expandedMsgs.delete(seq);
      body?.classList.toggle("clamp", !expand);
      body?.classList.toggle("is-clamped", !expand);
      more.setAttribute("aria-expanded", String(expand));
      more.textContent = expand ? "Show less" : "Show more";
      return;
    }
    const seatRow = event.target.closest(".seat-row, .cs-seat");
    if (seatRow) setSeatFilter(seatRow.dataset.seat);
  });
  els.railBody.addEventListener("click", (event) => {
    const seatRow = event.target.closest(".seat-row");
    if (seatRow) setSeatFilter(seatRow.dataset.seat);
  });

  els.header.addEventListener("click", (event) => {
    const button = event.target.closest(".ruling-form button[type=submit]");
    if (button) button.form.dataset.ruling = button.value;
  });
  els.header.addEventListener("submit", (event) => {
    const form = event.target.closest("form.ruling-form");
    if (!form) return;
    event.preventDefault();
    submitRuling(form, event.submitter?.value ?? form.dataset.ruling);
  });
  els.header.addEventListener("input", (event) => {
    const form = event.target.closest("form.ruling-form");
    if (!form || event.target.tagName !== "TEXTAREA") return;
    state.rulingDrafts.set(form.dataset.cid, event.target.value);
    event.target.removeAttribute("aria-invalid");
    const error = form.querySelector(".field-error");
    if (error) error.hidden = true;
  });
  els.header.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.confirmStop) {
      event.preventDefault();
      runAction("stop-cancel", event.target);
    }
  });

  for (const name of TABS) {
    const tab = els.tabs[name];
    tab.addEventListener("click", () => setTab(name));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = TABS.indexOf(state.tab);
      const target = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
      setTab(TABS[target], { focus: true });
    });
  }

  // <details> toggle does not bubble, but it does pass through the capture phase.
  els.view.addEventListener(
    "toggle",
    (event) => {
      const key = event.target?.dataset?.key;
      if (key) state.detailsOpen.set(key, event.target.open);
    },
    true,
  );

  const onScroll = () => {
    if (!els.jump.hidden && nearBottom()) els.jump.hidden = true;
  };
  els.sessionPanel.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  els.jump.addEventListener("click", () => scrollToBottom());

  // New council sheet
  wireDialog(els.ncDialog);
  els.ncForm.addEventListener("submit", convene);
  els.ncModelsBody.addEventListener("input", (event) => {
    const row = event.target.closest("[data-council-model]");
    const field = event.target.closest(".model-field");
    if (!row || !field) return;
    const seatId = row.dataset.councilModel;
    const value = readModelPick(field, event.target);
    if (value) state.councilModels.set(seatId, value);
    else state.councilModels.delete(seatId);
    const seat = councilModelSeats().find((entry) => entry.id === seatId);
    const help = document.getElementById(field.querySelector("select").getAttribute("aria-describedby"));
    if (seat && help) help.innerHTML = catalogHelpHtml(seat, value);
    els.ncModelsSummary.textContent = state.councilModels.size ? `${plural(state.councilModels.size, "seat")} switched for this council` : "Each seat’s saved model";
  });
  els.ncForm.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      els.ncForm.requestSubmit();
    } else if (event.target.matches("input")) {
      // Convening is billed: Enter in the folder field, a model field or the "Run anyway" checkbox
      // must not submit the form. Only Ctrl/Cmd+Enter or the Convene button does.
      event.preventDefault();
    }
  });
  els.ncTask.addEventListener("input", () => {
    els.ncTask.removeAttribute("aria-invalid");
    els.ncError.hidden = true;
  });
  els.ncBrowse.addEventListener("click", () => (els.ncBrowser.hidden ? openFolderBrowser() : closeFolderBrowser()));
  els.ncBrowser.addEventListener("click", (event) => {
    const item = event.target.closest("[data-fb-path]");
    if (item) {
      browseTo(item.dataset.fbPath).then(() => (els.ncFbList.querySelector("button") ?? els.ncFbUse).focus());
      return;
    }
    const action = event.target.closest("[data-fb]")?.dataset.fb;
    if (action === "up" && state.browser?.parent) browseTo(state.browser.parent);
    else if (action === "home") browseTo("~");
    else if (action === "use" && state.browser) {
      els.ncCwd.value = state.browser.path;
      closeFolderBrowser();
      inspectRepo();
      els.ncCwd.focus();
    }
  });
  els.ncBrowser.addEventListener("keydown", (event) => {
    // Esc closes the folder browser, not the whole sheet.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFolderBrowser();
      els.ncBrowse.focus();
    }
  });
  els.ncCwd.addEventListener("input", () => {
    inspectRepo({ debounce: true });
    els.ncCwd.removeAttribute("aria-invalid");
    els.ncError.hidden = true;
  });

  // Settings sheet: nothing is written until Save.
  wireDialog(els.stDialog, {
    canDismiss: () => !settingsDirty(),
    onClose: () => {
      state.settings = null;
    },
    onKeptOpen: () => {
      els.stStatus.textContent = "You have unsaved changes. Save them, or choose Cancel to discard them.";
      els.stStatus.className = "sheet-status";
    },
  });
  els.stSave.addEventListener("click", saveSettings);
  els.stBody.addEventListener("click", (event) => {
    if (event.target.closest("[data-action=recheck]")) {
      loadAuth(true);
      return;
    }
    const tester = event.target.closest("[data-action=test-model]");
    if (tester) {
      testModel(tester.dataset.seat);
      return;
    }
    const toggle = event.target.closest("[data-toggle]");
    if (!toggle || !state.settings?.draft) return;
    if (toggle.getAttribute("aria-disabled") === "true") {
      els.stStatus.textContent = "Claude can’t be turned off: it plans, executes and remediates every change.";
      els.stStatus.className = "sheet-status";
      return;
    }
    const seat = state.settings.draft.find((entry) => entry.id === toggle.dataset.toggle);
    if (!seat) return;
    seat.enabled = !seat.enabled;
    toggle.setAttribute("aria-checked", String(seat.enabled));
    toggle.closest(".set-seat")?.classList.toggle("is-off", !seat.enabled);
    els.stSave.disabled = !settingsDirty();
    els.stStatus.textContent = "";
  });
  els.stBody.addEventListener("input", (event) => {
    const row = event.target.closest("[data-model]");
    const picker = event.target.closest(".model-field");
    if (!row || !picker || !state.settings?.draft) return;
    const seat = state.settings.draft.find((entry) => entry.id === row.dataset.model);
    const field = row.dataset.field;
    if (!seat || (field !== "cliModel" && field !== "xeniaModel")) return;
    seat[field] = readModelPick(picker, event.target);
    els.stSave.disabled = !settingsDirty();
    // A stale test result must not vouch for a model that has since been edited.
    state.settings.tests.delete(seat.id);
    const help = document.getElementById(picker.querySelector("select").getAttribute("aria-describedby"));
    if (help) help.innerHTML = catalogHelpHtml(seat, seat[field]);
    row.closest(".set-extra")?.querySelector('[role="status"]')?.remove();
  });
  els.stBody.addEventListener("keydown", (event) => {
    // Enter in a model field must not submit or close anything; Save is the only write.
    if (event.key === "Enter" && event.target.matches("[data-model-custom]")) event.preventDefault();
  });

  // Navigation and lifecycle
  window.addEventListener("hashchange", () => {
    const id = readHash();
    if (id && id !== state.selectedId) selectSession(id);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshSessions();
      loadUsage();
    }
  });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      syncTaskToggle();
      applyListOpen();
      if (state.tab === "timeline") measureClamps(els.panels.timeline);
    }, 150);
  });
}

function poll() {
  refreshSessions();
  // Runs driven by another process also reach the stream now; this is a quiet fallback.
  if (state.session?.state === "running") catchUpMessages();
}

async function boot() {
  // Only a real path is worth restoring: "." (the old default) meant the server's own folder.
  const savedCwd = readStorage("conclave.cwd");
  if (savedCwd && /^(\/|~)/.test(savedCwd)) els.ncCwd.value = savedCwd;
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
  els.ncHint.innerHTML = `<kbd>${mac ? "⌘" : "Ctrl"}</kbd> <kbd>Enter</kbd> to convene`;
  // On a phone, a session named in the URL comes first; the list starts folded away.
  if (isNarrow() && readHash()) state.listOpen = false;
  wire();
  applyListOpen();
  renderConn();
  loadAuth(false);
  loadUsage();
  await Promise.all([loadSeats(), refreshSessions()]);
  const fromHash = readHash();
  const initial = fromHash || (isNarrow() ? null : firstSessionId());
  if (initial) await selectSession(initial);
  setInterval(poll, SESSION_POLL_MS);
  setInterval(loadUsage, USAGE_POLL_MS);
  setInterval(() => {
    if (!document.hidden) renderSessionList(); // keeps "5 min ago" honest
  }, 60_000);
}

boot();
