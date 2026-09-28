// Conclave browser UI. Vanilla JS, no build step, no dependencies.
//
// Every string that comes from the server (task text, model output, seat labels, error messages)
// is untrusted: it is either passed through escapeHtml() before being interpolated into markup or
// assigned with textContent. CSS class names are only ever taken from fixed allowlists.

const PAGE_SIZE = 20; // sessions per "Load more"
const MAX_SESSION_REQUEST = 100; // server cap for /api/sessions?limit=
// Server cap for /api/sessions/:id/messages?limit=. The limit bounds the *events* the server scans,
// not the messages it returns (non-message events are filtered out afterwards), so a short page does
// not mean the end: keep paging until a page comes back empty.
const MESSAGE_PAGE = 200;
const SESSION_POLL_MS = 10_000;
const USAGE_POLL_MS = 30_000;
const DETAIL_DEBOUNCE_MS = 1_000;
const SEAT_ACTIVITY_LIMIT = 30;
const NOTE_TIMEOUT_MS = 4_000;
const RESUMABLE = new Set(["orphaned", "cancelled", "errored", "not_approved", "awaiting_human"]);

const STATE_LABELS = {
  running: "running",
  orphaned: "orphaned",
  approved: "approved",
  not_approved: "not approved",
  awaiting_human: "awaiting ruling",
  cancelled: "cancelled",
  errored: "errored",
};
const OUTCOME_LABELS = { APPROVED: "Approved", NOT_APPROVED: "Not approved", AWAITING_HUMAN: "Awaiting human ruling" };
const SEVERITIES = ["BLOCKER", "MAJOR", "MINOR", "NIT"];
const VERDICT_LABELS = { APPROVE: "approve", APPROVE_WITH_CHANGES: "approve with changes", REJECT: "reject" };
const CONTENTION_LABELS = {
  OPEN: "open",
  ACCEPTED: "accepted",
  WITHDRAWN: "withdrawn",
  SUPERSEDED: "superseded",
  DEFERRED: "deferred",
  ARBITRATED: "arbitrated",
  HUMAN_ARBITRATION: "needs your ruling",
};
const VERIFICATION_LABELS = { TRUE: "reproduced", FALSE: "refuted", INCONCLUSIVE: "inconclusive" };
const RULING_LABELS = { UPHELD: "upheld", DISMISSED: "dismissed", DEFERRED: "deferred" };
const WORKTREE_LABELS = { active: "worktree active", kept: "worktree kept", removed: "worktree removed", none: "no worktree" };
const KNOWN_SEAT_HUES = { claude: 18, codex: 214, antigravity: 42 };

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  statusText: $("status-text"),
  usage5h: $("usage-5h"),
  usageWeek: $("usage-week"),
  composer: $("composer"),
  message: $("message"),
  cwd: $("cwd"),
  composerError: $("composer-error"),
  convene: $("convene"),
  sessionList: $("session-list"),
  sessionCount: $("session-count"),
  sessionsError: $("sessions-error"),
  loadMore: $("load-more-sessions"),
  sessionPanel: $("session-panel"),
  empty: $("session-empty"),
  view: $("session-view"),
  summary: $("session-summary"),
  actionMsg: $("action-msg"),
  tabActivity: $("tab-activity"),
  tabDeliberation: $("tab-deliberation"),
  activityCount: $("activity-count"),
  deliberationCount: $("deliberation-count"),
  scroll: $("session-scroll"),
  panelActivity: $("panel-activity"),
  panelDeliberation: $("panel-deliberation"),
  feed: $("feed"),
  jump: $("jump-latest"),
  seatList: $("seat-list"),
  seatProblem: $("seat-problem"),
  seatError: $("seat-error"),
  recheck: $("recheck-auth"),
  authChecked: $("auth-checked"),
};

const state = {
  // Session list
  sessions: [],
  sessionPages: 1,
  hasMoreSessions: false,
  sessionsInFlight: null,
  sessionsAgain: false,
  apiDown: false,
  // Selected session
  selectedId: null,
  selectToken: 0,
  session: null,
  sessionJson: "",
  sessionError: null,
  lastSeq: 0,
  messageCount: 0,
  seatMessages: new Map(),
  eventSource: null,
  connection: "idle",
  detailTimer: null,
  catchingUp: false,
  tab: "activity",
  scrollPos: { activity: null, deliberation: 0 },
  detailsOverride: new Map(),
  rulingDrafts: new Map(),
  // Seats
  seatSnapshot: null,
  seatRefs: new Map(),
  seatNotes: new Map(),
  auth: new Map(),
  authCheckedAt: null,
  authLoading: false,
  authStale: false,
  authError: null,
  usageError: false,
};

let actionMsgTimer = null;

// ---------------------------------------------------------------------------------------------
// Utilities

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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

function usd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function humanPhase(phase) {
  if (!phase) return "";
  const text = String(phase).replaceAll("_", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function roundLabel(round) {
  return Number.isInteger(round) ? `round ${round + 1}` : "";
}

function timeLabel(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function dateTimeAttr(ts) {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Maps an enum value to a CSS class suffix, but only for values in the allowlist. */
function classFor(labels, value) {
  return Object.prototype.hasOwnProperty.call(labels, value) ? String(value).toLowerCase().replaceAll("_", "-") : "unknown";
}

function badge(prefix, labels, value, labelOverride) {
  const cls = classFor(labels, value);
  const label = labelOverride ?? labels[value] ?? String(value ?? "unknown").toLowerCase();
  return `<span class="badge ${prefix}-${cls}">${escapeHtml(label)}</span>`;
}

function stateBadge(sessionState, pending = 0) {
  // awaiting_human stays the state until the session is resumed, even once every ruling is in.
  const settled = sessionState === "awaiting_human" && !(pending > 0);
  const label = settled ? "ready to resume" : STATE_LABELS[sessionState] ?? String(sessionState ?? "unknown");
  const suffix = sessionState === "awaiting_human" && pending > 0 ? ` · ${pending}` : "";
  const cls = classFor(STATE_LABELS, sessionState);
  return `<span class="badge st-${cls}"><i aria-hidden="true"></i>${escapeHtml(label + suffix)}</span>`;
}

function severityBadge(severity) {
  const cls = SEVERITIES.includes(severity) ? severity.toLowerCase() : "unknown";
  return `<span class="badge sev-${cls}">${escapeHtml(String(severity ?? "?").toLowerCase())}</span>`;
}

function verdictBadge(verdict) {
  if (!verdict || typeof verdict !== "object" || !verdict.overall_verdict) return `<span class="badge vd-unknown">no verdict</span>`;
  return badge("vd", VERDICT_LABELS, verdict.overall_verdict);
}

function seatHue(id) {
  if (Object.prototype.hasOwnProperty.call(KNOWN_SEAT_HUES, id)) return KNOWN_SEAT_HUES[id];
  let hash = 0;
  for (const ch of String(id ?? "")) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  return hash;
}

function initials(label) {
  const words = String(label ?? "?").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : String(words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function seatLabel(id) {
  const fromSession = state.session?.seats?.find((seat) => seat.id === id);
  if (fromSession?.label) return fromSession.label;
  const fromConfig = state.seatSnapshot?.seats?.find((seat) => seat.id === id);
  return fromConfig?.label || id || "seat";
}

function countBySeverity(findings) {
  const counts = {};
  for (const finding of findings) counts[finding?.severity] = (counts[finding?.severity] ?? 0) + 1;
  return counts;
}

function severityChips(counts) {
  return SEVERITIES.filter((sev) => counts[sev])
    .map((sev) => `<span class="badge sev-${sev.toLowerCase()}">${escapeHtml(`${Number(counts[sev]) || 0} ${sev.toLowerCase()}`)}</span>`)
    .join("");
}

/**
 * Re-renders a container without dropping keyboard focus or a half-typed value: the focused
 * control is found again by id afterwards and gets its value and caret back.
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
  if (!next) return;
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

function isDetailsOpen(key, defaultOpen) {
  return state.detailsOverride.has(key) ? state.detailsOverride.get(key) : defaultOpen;
}

function showFormError(el, message) {
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;
}

function showActionMsg(message, kind = "info") {
  clearTimeout(actionMsgTimer);
  els.actionMsg.textContent = message;
  els.actionMsg.dataset.kind = kind;
  els.actionMsg.hidden = !message;
  if (message && kind !== "error") actionMsgTimer = setTimeout(() => (els.actionMsg.hidden = true), 12_000);
}

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
    // storage unavailable (private mode, blocked): purely a convenience
  }
}

// ---------------------------------------------------------------------------------------------
// Header: status and usage

function renderStatus() {
  const running = state.sessions.filter((session) => session.state === "running").length;
  let text;
  let kind;
  if (state.apiDown) {
    text = "Server unreachable";
    kind = "bad";
  } else if (!state.selectedId) {
    text = "Idle";
    kind = "idle";
  } else {
    [text, kind] = {
      live: ["Live", "live"],
      connecting: ["Connecting…", "wait"],
      reconnecting: ["Reconnecting…", "wait"],
      closed: ["Stream closed", "bad"],
      idle: ["Idle", "idle"],
    }[state.connection] ?? ["Idle", "idle"];
  }
  if (running > 0 && !state.apiDown) text += ` · ${running} running`;
  els.statusText.textContent = text;
  els.status.dataset.kind = kind;
}

function setConnection(connection) {
  state.connection = connection;
  renderStatus();
}

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
  const summary = `${label} spend: ${usd(total)} of ${usd(limit)}, ${usd(win.remainingUsd)} remaining`;
  el.title = summary;
  el.setAttribute("aria-label", summary);
}

async function loadUsage() {
  try {
    const usage = await api("/api/usage");
    renderMeter(els.usage5h, "5-hour", usage?.fiveHour);
    renderMeter(els.usageWeek, "Weekly", usage?.weekly);
  } catch {
    // The session poll reports reachability; a stale meter is harmless.
  }
}

// ---------------------------------------------------------------------------------------------
// Session list

function sessionSignature(session) {
  return session ? [session.state, session.spentUsd, session.currentPhase, session.currentRound, session.phaseOpen, session.awaitingHumanRuling].join("|") : "";
}

function renderSessionList() {
  const list = els.sessionList;
  els.sessionCount.textContent = state.sessions.length ? `${state.sessions.length}${state.hasMoreSessions ? "+" : ""}` : "";
  els.loadMore.hidden = !state.hasMoreSessions;
  if (state.sessions.length === 0) {
    list.innerHTML = `<li class="empty">No sessions yet. Convene the council to start one.</li>`;
    return;
  }
  preserveFocus(list, () => {
    list.innerHTML = state.sessions
      .map((session) => {
        const current = session.sessionId === state.selectedId;
        const task = String(session.task || "").trim() || "(untitled task)";
        const phase = session.state === "running" && session.currentPhase ? `${humanPhase(session.currentPhase)} · r${(session.currentRound ?? 0) + 1}` : "";
        return `<li>
          <button type="button" class="session-item" id="session-item-${escapeHtml(session.sessionId)}" data-id="${escapeHtml(session.sessionId)}"${current ? ' aria-current="true"' : ""}>
            <span class="session-task">${escapeHtml(task)}</span>
            <span class="session-meta">
              ${stateBadge(session.state, session.awaitingHumanRuling)}
              ${phase ? `<span class="session-phase">${escapeHtml(phase)}</span>` : ""}
              <span class="session-cost" title="Spend">${escapeHtml(usd(session.spentUsd))}</span>
            </span>
          </button>
        </li>`;
      })
      .join("");
  });
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
    if (sessions.length < limit) {
      exhausted = true;
      break;
    }
    offset += limit;
  }
  return { sessions: collected, hasMore: !exhausted };
}

/** Refreshes every loaded page of the session list. Concurrent calls coalesce into one follow-up. */
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
        state.hasMoreSessions = hasMore;
        state.apiDown = false;
        showFormError(els.sessionsError, "");
      } catch (error) {
        state.apiDown = error.status === 0;
        showFormError(els.sessionsError, `Could not load sessions: ${error.message}`);
        break;
      } finally {
        renderStatus();
      }
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

// ---------------------------------------------------------------------------------------------
// Session selection, messages, and live stream

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
  clearTimeout(state.detailTimer);
  state.detailTimer = null;
}

async function selectSession(id, { focus = false } = {}) {
  if (!id) return;
  const token = ++state.selectToken;
  closeEvents();
  state.catchingUp = false;
  state.selectedId = id;
  state.session = null;
  state.sessionJson = "";
  state.sessionError = null;
  state.lastSeq = 0;
  state.messageCount = 0;
  state.seatMessages = new Map();
  state.detailsOverride = new Map();
  state.rulingDrafts = new Map();
  writeHash(id);
  showActionMsg("");
  setConnection("connecting");
  renderSessionList();

  els.empty.hidden = true;
  els.view.hidden = false;
  els.summary.innerHTML = `<p class="loading">Loading session…</p>`;
  els.feed.innerHTML = `<p class="loading">Loading activity…</p>`;
  els.panelDeliberation.innerHTML = "";
  els.activityCount.textContent = "";
  els.deliberationCount.textContent = "";
  els.jump.hidden = true;
  state.tab = "activity";
  state.scrollPos = { activity: null, deliberation: 0 };
  setTab("activity");
  renderSeats();
  if (focus) els.sessionPanel.focus({ preventScroll: false });

  // Detail first, so seat labels are known before the feed renders.
  await loadSessionDetail(token);
  if (token !== state.selectToken || state.sessionError) return;
  const loaded = await loadAllMessages(token);
  if (token !== state.selectToken || !loaded) return;
  connectEvents(id, token);
}

async function loadSessionDetail(token = state.selectToken) {
  const id = state.selectedId;
  if (!id) return;
  try {
    const { session } = await api(sessionPath(id));
    if (token !== state.selectToken) return;
    state.sessionError = null;
    const json = JSON.stringify(session);
    if (json === state.sessionJson) return;
    const previous = state.session;
    state.session = session;
    state.sessionJson = json;
    renderSummary();
    renderDeliberation();
    const seatsBefore = (previous?.seats ?? []).map((seat) => seat.id).join(",");
    const seatsAfter = (session.seats ?? []).map((seat) => seat.id).join(",");
    if (!previous || seatsBefore !== seatsAfter) renderSeats();
    if (previous && previous.state !== session.state) refreshSessions();
  } catch (error) {
    if (token !== state.selectToken) return;
    if (error.status === 404) {
      state.sessionError = error.message;
      closeEvents();
      setConnection("idle");
      els.summary.innerHTML = `<div class="callout error"><div><strong>Session not found</strong><p>${escapeHtml(error.message)}</p></div></div>`;
      els.feed.innerHTML = "";
    } else {
      showActionMsg(`Could not refresh the session: ${error.message}`, "error");
    }
  }
}

function scheduleDetailRefresh() {
  if (!state.selectedId || state.detailTimer) return;
  const token = state.selectToken;
  state.detailTimer = setTimeout(() => {
    state.detailTimer = null;
    if (token === state.selectToken) loadSessionDetail(token);
  }, DETAIL_DEBOUNCE_MS);
}

/** Fetches and renders the page after the last rendered seq; `more` is false once nothing newer came back. */
async function fetchMessagePage(id, token, options) {
  const before = state.lastSeq;
  const page = await api(sessionPath(id, `/messages?after=${before}&limit=${MESSAGE_PAGE}`));
  if (token !== state.selectToken) return { stale: true, more: false, added: 0 };
  const messages = Array.isArray(page?.messages) ? page.messages : [];
  const added = appendMessages(messages, options);
  // Stop on an empty page, and never loop on a page that did not move the cursor forward.
  return { stale: false, more: messages.length > 0 && state.lastSeq > before, added };
}

async function loadAllMessages(token) {
  const id = state.selectedId;
  els.feed.innerHTML = "";
  // Shares the catch-up flag so the running-session poll cannot page concurrently with this.
  state.catchingUp = true;
  try {
    for (;;) {
      const { stale, more } = await fetchMessagePage(id, token, { initial: true });
      if (stale) return false;
      if (!more) break;
    }
  } catch (error) {
    if (token !== state.selectToken) return false;
    els.feed.insertAdjacentHTML("beforeend", `<div class="callout error"><div><strong>Could not load activity</strong><p>${escapeHtml(error.message)}</p></div></div>`);
    return false;
  } finally {
    if (token === state.selectToken) state.catchingUp = false;
  }
  if (state.messageCount === 0) els.feed.innerHTML = `<p class="empty">No activity recorded yet.</p>`;
  scrollFeedToBottom();
  return true;
}

/** Pulls anything newer than the last rendered message; covers runs that do not broadcast here. */
async function catchUpMessages() {
  if (state.catchingUp || !state.selectedId || state.sessionError) return;
  const token = state.selectToken;
  state.catchingUp = true;
  let added = 0;
  try {
    for (;;) {
      const page = await fetchMessagePage(state.selectedId, token);
      if (page.stale) return;
      added += page.added;
      if (!page.more) break;
    }
  } catch {
    // The next poll tries again.
  } finally {
    if (token === state.selectToken) state.catchingUp = false;
  }
  if (added > 0) scheduleDetailRefresh();
}

function connectEvents(id, token) {
  closeEvents();
  const source = new EventSource(sessionPath(id, `/events?lastEventId=${state.lastSeq}`));
  source.onopen = () => {
    if (token === state.selectToken) setConnection("live");
  };
  source.onmessage = (event) => {
    if (token !== state.selectToken) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (appendMessages([message]) > 0) scheduleDetailRefresh();
  };
  source.onerror = () => {
    if (token !== state.selectToken) return;
    setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
  };
  state.eventSource = source;
}

function nearBottom() {
  const el = els.scroll;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

function scrollFeedToBottom() {
  if (state.tab !== "activity") {
    state.scrollPos.activity = null;
    return;
  }
  els.scroll.scrollTop = els.scroll.scrollHeight;
  els.jump.hidden = true;
}

/** Renders messages newer than the last rendered seq, in order. Returns how many were added. */
function appendMessages(messages, { initial = false } = {}) {
  const fresh = messages.filter((message) => message && Number.isFinite(message.seq) && message.seq > state.lastSeq).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return 0;
  const stick = initial || (state.tab === "activity" && nearBottom());
  const empty = els.feed.querySelector(":scope > .empty");
  if (empty) empty.remove();

  const touchedSeats = new Set();
  let unknownSeat = false;
  let html = "";
  for (const message of fresh) {
    html += messageHtml(message);
    if (!initial && message.activityKind === "system" && /^Resume failed/.test(String(message.text))) showActionMsg(message.text, "error");
    state.lastSeq = message.seq;
    state.messageCount += 1;
    if (message.activityKind === "seat" && message.seat) {
      if (!state.seatMessages.has(message.seat)) state.seatMessages.set(message.seat, []);
      state.seatMessages.get(message.seat).push(message);
      touchedSeats.add(message.seat);
      if (!state.seatRefs.has(message.seat)) unknownSeat = true;
    }
  }
  els.feed.insertAdjacentHTML("beforeend", html);
  els.activityCount.textContent = String(state.messageCount);

  if (unknownSeat) renderSeats();
  else for (const seatId of touchedSeats) renderSeatActivity(seatId);

  if (!initial) {
    if (stick) scrollFeedToBottom();
    else if (state.tab === "activity") els.jump.hidden = false;
  }
  return fresh.length;
}

// ---------------------------------------------------------------------------------------------
// Feed rendering

function renderReport(text) {
  // Minimal, safe markdown: #/##/### headings, "- " bullets (with indented continuation lines),
  // and paragraphs. Everything else is escaped plain text.
  const blocks = [];
  let current = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    let match;
    if (!line.trim()) {
      current = null;
    } else if ((match = /^(#{1,3})\s+(.*)$/.exec(line))) {
      blocks.push({ type: "h", level: match[1].length, text: match[2] });
      current = null;
    } else if ((match = /^ ?[-*]\s+(.*)$/.exec(line))) {
      if (current?.type !== "ul") {
        current = { type: "ul", items: [] };
        blocks.push(current);
      }
      current.items.push([match[1]]);
    } else if (/^\s{2,}\S/.test(line) && current?.type === "ul") {
      current.items[current.items.length - 1].push(line.trim());
    } else {
      if (current?.type !== "p") {
        current = { type: "p", lines: [] };
        blocks.push(current);
      }
      current.lines.push(line.trim());
    }
  }
  return blocks
    .map((block) => {
      if (block.type === "h") {
        const tag = `h${Math.min(6, block.level + 3)}`;
        return `<${tag} class="report-h">${escapeHtml(block.text)}</${tag}>`;
      }
      if (block.type === "ul") return `<ul>${block.items.map((lines) => `<li>${lines.map(escapeHtml).join("<br>")}</li>`).join("")}</ul>`;
      return `<p>${block.lines.map(escapeHtml).join("<br>")}</p>`;
    })
    .join("");
}

function messageMeta(message) {
  return [humanPhase(message.phase), roundLabel(message.round)].filter(Boolean).join(" · ");
}

function timeTag(ts) {
  return `<time datetime="${escapeHtml(dateTimeAttr(ts))}">${escapeHtml(timeLabel(ts))}</time>`;
}

function messageHtml(message) {
  if (message.kind === "user") {
    return `<article class="msg msg-user">
      <header class="msg-head"><span class="msg-who">You</span>${timeTag(message.ts)}</header>
      <p class="msg-text">${escapeHtml(message.text)}</p>
    </article>`;
  }
  switch (message.activityKind) {
    case "phase":
      return `<h3 class="phase-divider"><span>${escapeHtml(message.text)}</span></h3>`;
    case "seat":
      return seatMessageHtml(message);
    case "report":
      return `<article class="msg msg-report">
        <header class="msg-head"><span class="msg-who">Final report</span>${timeTag(message.ts)}</header>
        <div class="report-body">${renderReport(message.text)}</div>
      </article>`;
    default: {
      const failed = /^(Resume failed|Verification of .* failed)/.test(String(message.text));
      const meta = messageMeta(message);
      return `<div class="msg msg-system${failed ? " is-error" : ""}">
        <p class="msg-text">${escapeHtml(message.text)}</p>
        <span class="msg-meta">${meta ? `${escapeHtml(meta)} · ` : ""}${timeTag(message.ts)}</span>
      </div>`;
    }
  }
}

function findingsInline(findings) {
  const counts = countBySeverity(findings);
  return `<details class="msg-findings">
    <summary>${escapeHtml(plural(findings.length, "finding"))} <span class="chips">${severityChips(counts)}</span></summary>
    <ul>${findings
      .map(
        (finding) => `<li>${severityBadge(finding?.severity)} ${finding?.target ? `<code>${escapeHtml(finding.target)}</code> ` : ""}${escapeHtml(finding?.description ?? "")}</li>`,
      )
      .join("")}</ul>
  </details>`;
}

function seatMessageHtml(message) {
  const verdict = message.verdict && typeof message.verdict === "object" ? message.verdict : null;
  const findings = Array.isArray(verdict?.findings) ? verdict.findings : [];
  const meta = messageMeta(message);
  return `<article class="msg msg-seat${verdict ? "" : " no-verdict"}" style="--h:${seatHue(message.seat)}">
    <header class="msg-head">
      <span class="msg-who">${escapeHtml(seatLabel(message.seat))}</span>
      ${meta ? `<span class="msg-meta">${escapeHtml(meta)}</span>` : ""}
      ${verdictBadge(verdict)}
      ${timeTag(message.ts)}
    </header>
    <p class="msg-text">${escapeHtml(message.text)}</p>
    ${findings.length ? findingsInline(findings) : ""}
  </article>`;
}

// ---------------------------------------------------------------------------------------------
// Session summary and actions

function fact(label, valueHtml) {
  return valueHtml ? `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>` : "";
}

function latestArtifacts(artifacts) {
  const latest = new Map();
  for (const artifact of artifacts ?? []) {
    if (!latest.has(artifact.kind) || artifact.version > latest.get(artifact.kind)) latest.set(artifact.kind, artifact.version);
  }
  return [...latest].map(([kind, version]) => `${kind} v${version}`).join(" · ");
}

function outcomeText(session) {
  if (session.outcomeReason) return session.outcomeReason;
  switch (session.state) {
    case "running":
      return "In progress.";
    case "orphaned":
      return "The run stopped without concluding (its process exited). Resume to continue from the last phase.";
    case "cancelled":
      return session.cancelReason || "Cancelled.";
    case "errored":
      return session.fatalError || "The run failed.";
    default:
      return "";
  }
}

function renderSummary() {
  const session = state.session;
  if (!session) return;
  const pending = Array.isArray(session.awaitingHumanRuling) ? session.awaitingHumanRuling : [];
  const canCancel = session.state === "running";
  const canResume = RESUMABLE.has(session.state) && pending.length === 0;

  const phase = session.currentPhase
    ? `${escapeHtml(humanPhase(session.currentPhase))} · ${escapeHtml(roundLabel(session.currentRound ?? 0))}${session.phaseOpen ? ` <span class="muted">(in progress)</span>` : ""}`
    : `<span class="muted">not started</span>`;

  const spent = Number(session.spentUsd) || 0;
  const ceiling = Number(session.budgetCeilingUsd);
  const ratio = ceiling > 0 ? Math.min(1, spent / ceiling) : 0;
  const spend = Number.isFinite(ceiling) && ceiling > 0
    ? `${escapeHtml(usd(spent))} <span class="muted">of ${escapeHtml(usd(ceiling))}</span><span class="mini-bar${ratio >= 0.8 ? " is-warn" : ""}" aria-hidden="true"><span style="width:${(ratio * 100).toFixed(1)}%"></span></span>`
    : escapeHtml(usd(spent));

  const branch = session.branch
    ? `<code>${escapeHtml(session.branch)}</code> <span class="muted">· ${escapeHtml(WORKTREE_LABELS[session.worktreeState] ?? "")}</span>`
    : `<span class="muted">${escapeHtml(WORKTREE_LABELS[session.worktreeState] ?? "none")} · session</span> <code>${escapeHtml(session.sessionId)}</code>`;

  const outcome = session.outcome ? `<strong>${escapeHtml(OUTCOME_LABELS[session.outcome] ?? session.outcome)}.</strong> ` : "";
  const reason = outcomeText(session);
  const resumes = Array.isArray(session.resumes) && session.resumes.length
    ? `${escapeHtml(plural(session.resumes.length, "time"))} <span class="muted">(last: ${escapeHtml(session.resumes[session.resumes.length - 1].reason ?? "")})</span>`
    : "";

  let callouts = "";
  if (pending.length > 0) {
    callouts += `<div class="callout attention">
      <div>
        <strong>The council is waiting on you.</strong>
        <p>${escapeHtml(plural(pending.length, "contention"))} escalated to human arbitration. Rule on ${pending.length === 1 ? "it" : "each"} under Deliberation → Contentions, then resume.</p>
      </div>
      <button type="button" class="btn" id="action-review" data-action="review">Review ${pending.length === 1 ? "contention" : "contentions"}</button>
    </div>`;
  } else if (session.state === "awaiting_human") {
    callouts += `<div class="callout ok"><div><strong>All escalations are settled.</strong><p>Resume the session so the council can act on your rulings.</p></div></div>`;
  }
  if (session.fatalError && session.state === "errored") {
    callouts += `<div class="callout error"><div><strong>Fatal error</strong><p>${escapeHtml(session.fatalError)}</p></div></div>`;
  }

  preserveFocus(els.summary, () => {
    els.summary.innerHTML = `
      <div class="summary-head">
        <div class="summary-main">
          <div class="summary-badges">${stateBadge(session.state, pending.length)}</div>
          <h2 class="summary-task" id="session-heading" title="${escapeHtml(session.task ?? "")}">${escapeHtml(session.task || "(untitled task)")}</h2>
          ${reason || outcome ? `<p class="summary-outcome">${outcome}${escapeHtml(reason)}</p>` : ""}
        </div>
        <div class="summary-actions">
          ${canCancel ? `<button type="button" class="btn danger" id="action-cancel" data-action="cancel">Cancel run</button>` : ""}
          ${canResume ? `<button type="button" class="btn primary" id="action-resume" data-action="resume">Resume</button>` : ""}
        </div>
      </div>
      <dl class="facts">
        ${fact("Phase", phase)}
        ${fact("Spend", spend)}
        ${fact("Branch", branch)}
        ${fact("Artifacts", escapeHtml(latestArtifacts(session.artifacts)))}
        ${fact("Resumed", resumes)}
      </dl>
      ${callouts}`;
  });
}

async function runAction(action, button) {
  const id = state.selectedId;
  if (!id) return;
  if (action === "review") {
    reviewPendingContention();
    return;
  }
  button.disabled = true;
  try {
    if (action === "cancel") {
      await postJson(sessionPath(id, "/cancel"));
      showActionMsg("Cancellation requested. The run stops at its next checkpoint.", "ok");
    } else if (action === "resume") {
      await postJson(sessionPath(id, "/resume"));
      showActionMsg("Resume started. Progress streams into the activity feed; a failure to resume is reported there too.", "ok");
      setTab("activity");
      scrollFeedToBottom();
      if (!state.eventSource || state.eventSource.readyState === EventSource.CLOSED) connectEvents(id, state.selectToken);
    }
  } catch (error) {
    showActionMsg(error.message, "error");
    button.disabled = false;
  }
  await Promise.all([refreshSessions(), loadSessionDetail()]);
  setTimeout(() => {
    if (id !== state.selectedId) return;
    // Re-render even if nothing changed (e.g. a resume that failed validation) so the action
    // buttons come back enabled and reflect the current state.
    state.sessionJson = "";
    loadSessionDetail();
    catchUpMessages();
  }, 1_500);
}

function reviewPendingContention() {
  const pending = state.session?.awaitingHumanRuling ?? [];
  setTab("deliberation");
  state.detailsOverride.set("section:contentions", true);
  const section = els.panelDeliberation.querySelector('details[data-key="section:contentions"]');
  if (section) section.open = true;
  const index = (state.session?.contentions ?? []).findIndex((contention) => pending.includes(contention.contentionId));
  const card = index >= 0 ? document.getElementById(`contention-${index}`) : null;
  if (!card) return;
  // Scroll only the session pane; scrollIntoView() would also scroll the page.
  const top = card.getBoundingClientRect().top - els.scroll.getBoundingClientRect().top + els.scroll.scrollTop - 12;
  els.scroll.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  const pane = els.scroll.getBoundingClientRect();
  if (pane.top < 0 || pane.bottom > window.innerHeight) els.scroll.scrollIntoView({ block: "nearest" });
  const textarea = card.querySelector("textarea");
  if (textarea) textarea.focus({ preventScroll: true });
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// ---------------------------------------------------------------------------------------------
// Tabs

function setTab(name, { focus = false } = {}) {
  if (name !== state.tab) state.scrollPos[state.tab] = state.tab === "activity" && nearBottom() ? null : els.scroll.scrollTop;
  state.tab = name;
  const activity = name === "activity";
  els.tabActivity.setAttribute("aria-selected", String(activity));
  els.tabDeliberation.setAttribute("aria-selected", String(!activity));
  els.tabActivity.tabIndex = activity ? 0 : -1;
  els.tabDeliberation.tabIndex = activity ? -1 : 0;
  els.panelActivity.hidden = !activity;
  els.panelDeliberation.hidden = activity;
  els.jump.hidden = true;
  const saved = state.scrollPos[name];
  els.scroll.scrollTop = saved === null || saved === undefined ? (activity ? els.scroll.scrollHeight : 0) : saved;
  if (focus) (activity ? els.tabActivity : els.tabDeliberation).focus();
}

// ---------------------------------------------------------------------------------------------
// Deliberation

function detailsSection(key, title, countHtml, bodyHtml) {
  const open = isDetailsOpen(key, true);
  return `<details class="section" data-key="${escapeHtml(key)}"${open ? " open" : ""}>
    <summary><h3>${escapeHtml(title)}</h3>${countHtml}</summary>
    <div class="section-body">${bodyHtml}</div>
  </details>`;
}

function statsHtml(d) {
  const f = d?.findings ?? {};
  const c = d?.contentions ?? {};
  const a = d?.arbitrations ?? {};
  const v = d?.verifications ?? {};
  const stat = (label, value, detail) => `<div class="stat"><dt>${escapeHtml(label)}</dt><dd><strong>${escapeHtml(String(value ?? 0))}</strong><span>${detail}</span></dd></div>`;
  return `<dl class="stats">
    ${stat("Findings", f.total, `${escapeHtml(`${f.addressed ?? 0} addressed`)} ${severityChips(f.bySeverity ?? {})}`)}
    ${stat("Contentions", c.total, escapeHtml(`${c.open ?? 0} open · ${c.escalated ?? 0} escalated`))}
    ${stat("Arbitrations", a.total, escapeHtml(`${a.upheld ?? 0} upheld · ${a.dismissed ?? 0} dismissed · ${a.deferred ?? 0} deferred · ${a.byHuman ?? 0} by you`))}
    ${stat("Verifications", v.total, escapeHtml(`${v.reproduced ?? 0} reproduced · ${v.refuted ?? 0} refuted · ${v.inconclusive ?? 0} inconclusive`))}
  </dl>`;
}

function findingsHtml(findings) {
  if (!findings.length) return `<p class="empty">No findings recorded.</p>`;
  const rank = (sev) => {
    const index = SEVERITIES.indexOf(sev);
    return index < 0 ? SEVERITIES.length : index;
  };
  const sorted = [...findings].sort((a, b) => Number(a.addressed) - Number(b.addressed) || rank(a.severity) - rank(b.severity));
  return `<ul class="finding-list">${sorted
    .map((finding) => {
      const sevClass = SEVERITIES.includes(finding.severity) ? finding.severity.toLowerCase() : "unknown";
      const confidence = Number.isFinite(finding.confidence) ? `${Math.round(finding.confidence * 100)}% confidence` : "";
      return `<li class="finding sev-edge-${sevClass}${finding.addressed ? " is-addressed" : ""}">
        <div class="finding-head">
          ${severityBadge(finding.severity)}
          <span class="finding-seat" style="--h:${seatHue(finding.seat)}">${escapeHtml(seatLabel(finding.seat))}</span>
          ${finding.target ? `<code class="target">${escapeHtml(finding.target)}</code>` : ""}
          ${finding.addressed ? `<span class="addressed"><span aria-hidden="true">✓</span> addressed</span>` : `<span class="unaddressed">not addressed</span>`}
        </div>
        <p class="finding-desc">${escapeHtml(finding.description)}</p>
        ${finding.falsifiableTest ? `<div class="ftest"><span class="ftest-label">Falsifiable test</span><pre><code>${escapeHtml(finding.falsifiableTest)}</code></pre></div>` : ""}
        <p class="finding-foot">${[finding.category, confidence, finding.id ? `id ${finding.id}` : ""].filter(Boolean).map(escapeHtml).join(" · ")}</p>
      </li>`;
    })
    .join("")}</ul>`;
}

function rulingHtml(ruling) {
  if (!ruling) return "";
  const source = ruling.source === "human" ? "human ruling" : "policy ruling";
  const arbiters = Array.isArray(ruling.arbiters) && ruling.arbiters.length ? ` · arbiters: ${ruling.arbiters.map(seatLabel).join(", ")}` : "";
  return `<div class="ruling">
    <div class="ruling-head"><span class="ruling-title">Ruling</span>${badge("rl", RULING_LABELS, ruling.ruling)}<span class="muted">${escapeHtml(source + arbiters)}</span></div>
    ${ruling.reasoning ? `<p>${escapeHtml(ruling.reasoning)}</p>` : ""}
  </div>`;
}

function rulingFormHtml(contention, index) {
  const base = `ruling-${index}`;
  const draft = state.rulingDrafts.get(contention.contentionId) ?? "";
  return `<form class="ruling-form" data-cid="${escapeHtml(contention.contentionId)}" novalidate>
    <label class="field-label" for="${base}-reason">Your reasoning <span class="req">(required)</span></label>
    <textarea id="${base}-reason" rows="3" aria-required="true" aria-describedby="${base}-help">${escapeHtml(draft)}</textarea>
    <p class="hint" id="${base}-help"><strong>Uphold</strong>: the objection stands and the council must resolve it. <strong>Dismiss</strong>: the objection is overruled and will not be raised again.</p>
    <p class="form-error" role="alert" hidden></p>
    <div class="ruling-actions">
      <button type="submit" class="btn" id="${base}-uphold" value="UPHELD">Uphold</button>
      <button type="submit" class="btn" id="${base}-dismiss" value="DISMISSED">Dismiss</button>
    </div>
  </form>`;
}

function contentionsHtml(contentions, pending) {
  if (!contentions.length) return `<p class="empty">No contentions: the seats did not dispute anything.</p>`;
  return `<ol class="contention-list">${contentions
    .map((contention, index) => {
      const awaiting = contention.status === "HUMAN_ARBITRATION" && pending.includes(contention.contentionId);
      const thread = Array.isArray(contention.thread) ? contention.thread : [];
      const targets = (contention.targets ?? []).map((target) => `<code>${escapeHtml(target)}</code>`).join(" ");
      return `<li class="contention${awaiting ? " is-awaiting" : ""}" id="contention-${index}" tabindex="-1">
        <div class="contention-head">
          ${badge("cs", CONTENTION_LABELS, contention.status)}
          ${severityBadge(contention.severity)}
          ${contention.category ? `<span class="muted">${escapeHtml(contention.category)}</span>` : ""}
          <span class="muted contention-id">${escapeHtml(contention.contentionId)}</span>
        </div>
        ${targets ? `<p class="contention-targets">${targets}</p>` : ""}
        ${thread.length
          ? `<ol class="thread">${thread
              .map(
                (entry) => `<li style="--h:${seatHue(entry.author)}">
                  <div class="thread-head"><span class="thread-author">${escapeHtml(seatLabel(entry.author))}</span><span class="stance">${escapeHtml(String(entry.stance ?? "").toLowerCase().replaceAll("_", " "))}</span></div>
                  <p>${escapeHtml(entry.reasoning)}</p>
                </li>`,
              )
              .join("")}</ol>`
          : `<p class="empty">No thread messages.</p>`}
        ${rulingHtml(contention.ruling)}
        ${awaiting ? rulingFormHtml(contention, index) : ""}
      </li>`;
    })
    .join("")}</ol>`;
}

function verificationsHtml(verifications) {
  if (!verifications.length) return `<p class="empty">No falsifiable tests were run.</p>`;
  return `<ul class="verification-list">${verifications
    .map((run, index) => {
      const key = `output:${index}`;
      return `<li class="verification">
        <div class="verification-head">
          ${badge("vr", VERIFICATION_LABELS, run.result)}
          <span>finding <code>${escapeHtml(run.findingId)}</code></span>
          ${run.contentionId ? `<span class="muted">contention <code>${escapeHtml(run.contentionId)}</code></span>` : ""}
        </div>
        ${run.command ? `<pre class="command"><code>${escapeHtml(run.command)}</code></pre>` : ""}
        ${run.output ? `<details class="output" data-key="${key}"${isDetailsOpen(key, false) ? " open" : ""}><summary>Output</summary><pre><code>${escapeHtml(run.output)}</code></pre></details>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
}

function ratificationsHtml(tallies) {
  if (!tallies.length) return `<p class="empty">No ratification votes yet.</p>`;
  const num = (value) => Number(value) || 0;
  const rows = tallies
    .map((raw) => {
      const tally = { phase: raw.phase, round: raw.round, approve: num(raw.approve), approveWithChanges: num(raw.approveWithChanges), reject: num(raw.reject), missing: num(raw.missing) };
      const total = tally.approve + tally.approveWithChanges + tally.reject + tally.missing || 1;
      const seg = (n, cls) => (n ? `<span class="seg ${cls}" style="width:${((n / total) * 100).toFixed(1)}%"></span>` : "");
      return `<tr>
        <th scope="row">${escapeHtml(humanPhase(tally.phase))} <span class="muted">${escapeHtml(roundLabel(tally.round))}</span></th>
        <td>${tally.approve}</td><td>${tally.approveWithChanges}</td><td>${tally.reject}</td><td>${tally.missing}</td>
        <td class="bar-cell"><span class="tally-bar" aria-hidden="true">${seg(tally.approve, "approve")}${seg(tally.approveWithChanges, "changes")}${seg(tally.reject, "reject")}${seg(tally.missing, "missing")}</span></td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="tally">
    <thead><tr><th scope="col">Vote</th><th scope="col">Approve</th><th scope="col">With changes</th><th scope="col">Reject</th><th scope="col">Missing</th><th scope="col"><span class="sr-only">Distribution</span></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderDeliberation() {
  const session = state.session;
  if (!session) return;
  const findings = Array.isArray(session.findings) ? session.findings : [];
  const contentions = Array.isArray(session.contentions) ? session.contentions : [];
  const verifications = Array.isArray(session.verifications) ? session.verifications : [];
  const tallies = Array.isArray(session.deliberation?.ratifications) ? session.deliberation.ratifications : [];
  const pending = Array.isArray(session.awaitingHumanRuling) ? session.awaitingHumanRuling : [];
  const count = (n, attention = false) => `<span class="section-count${attention ? " is-attention" : ""}">${escapeHtml(String(n))}</span>`;

  preserveFocus(els.panelDeliberation, () => {
    els.panelDeliberation.innerHTML = `
      ${statsHtml(session.deliberation)}
      ${detailsSection("section:findings", "Findings", count(findings.length), findingsHtml(findings))}
      ${detailsSection("section:contentions", "Contentions", count(pending.length ? `${pending.length} awaiting you` : contentions.length, pending.length > 0), contentionsHtml(contentions, pending))}
      ${detailsSection("section:verifications", "Verifications", count(verifications.length), verificationsHtml(verifications))}
      ${detailsSection("section:ratifications", "Ratification", count(tallies.length), ratificationsHtml(tallies))}`;
  });

  const total = findings.length + contentions.length;
  els.deliberationCount.textContent = pending.length ? `${pending.length} awaiting` : total ? String(total) : "";
  els.deliberationCount.classList.toggle("is-attention", pending.length > 0);
}

async function submitRuling(form, ruling) {
  const sessionId = state.selectedId;
  const contentionId = form.dataset.cid;
  const textarea = form.querySelector("textarea");
  const errorEl = form.querySelector(".form-error");
  const buttons = [...form.querySelectorAll("button")];
  const reasoning = textarea.value.trim();
  if (ruling !== "UPHELD" && ruling !== "DISMISSED") return;
  if (!reasoning) {
    showFormError(errorEl, "A reason is required. Tell the council why you are ruling this way.");
    textarea.setAttribute("aria-invalid", "true");
    textarea.focus();
    return;
  }
  showFormError(errorEl, "");
  for (const button of buttons) button.disabled = true;
  try {
    const result = await postJson(sessionPath(sessionId, `/contentions/${encodeURIComponent(contentionId)}/ruling`), { ruling, reasoning });
    state.rulingDrafts.delete(contentionId);
    const remaining = Array.isArray(result?.awaitingHumanRuling) ? result.awaitingHumanRuling.length : 0;
    const verb = ruling === "UPHELD" ? "upheld" : "dismissed";
    showActionMsg(
      remaining > 0
        ? `Ruling recorded: contention ${verb}. ${plural(remaining, "contention")} still ${remaining === 1 ? "needs" : "need"} a ruling.`
        : `Ruling recorded: contention ${verb}. Every escalation is settled; resume the session to continue.`,
      "ok",
    );
    await Promise.all([loadSessionDetail(), refreshSessions()]);
    if (remaining === 0) document.getElementById("action-resume")?.focus();
  } catch (error) {
    showFormError(errorEl, error.message);
    for (const button of buttons) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Seats

function seatUniverse() {
  const map = new Map();
  for (const seat of state.seatSnapshot?.seats ?? []) map.set(seat.id, { ...seat, configured: true });
  for (const seat of state.session?.seats ?? []) if (!map.has(seat.id)) map.set(seat.id, { ...seat, configured: false });
  for (const id of state.seatMessages.keys()) if (!map.has(id)) map.set(id, { id, label: id, configured: false });
  return [...map.values()];
}

function seatCardHtml(seat, index, inSession) {
  const base = `seat-${index}`;
  const isClaude = seat.id === "claude";
  const adapter = seat.adapter ?? "";
  const modelField = adapter === "cli" ? "cliModel" : adapter === "xenia" ? "xeniaModel" : null;
  const enabled = seat.configured && seat.enabled !== false;
  const meta = [seat.id, humanPhase(seat.role), adapter].filter(Boolean).join(" · ");
  const sessionNote = state.session && !inSession.has(seat.id) && seat.configured ? `<span class="chip">not in this session</span>` : "";

  let controls;
  if (!seat.configured) {
    controls = `<p class="hint">No longer in the seat configuration; shown because it sat in this session.</p>`;
  } else {
    const toggle = isClaude
      ? `<label class="check is-locked" for="${base}-enabled" title="Claude executes and remediates every change, so it cannot be disabled.">
          <input type="checkbox" id="${base}-enabled" checked disabled aria-describedby="${base}-lock"> Always on
        </label>
        <span class="sr-only" id="${base}-lock">Claude executes and remediates every change, so it cannot be disabled.</span>`
      : `<label class="check" for="${base}-enabled"><input type="checkbox" id="${base}-enabled" data-seat-toggle${enabled ? " checked" : ""}> Enabled</label>`;
    const model = modelField
      ? `<label class="model-field" for="${base}-model">
          <span>${adapter === "xenia" ? "Xenia model" : "Model"}</span>
          <input type="text" id="${base}-model" data-seat-model="${modelField}" value="${escapeHtml(seat[modelField] ?? "")}" placeholder="${adapter === "xenia" ? "required" : "CLI default"}" autocomplete="off" spellcheck="false">
        </label>`
      : `<p class="hint">In-process fake seat: no provider or model.</p>`;
    controls = `<div class="seat-controls">${toggle}${model}</div>`;
  }

  return `<article class="seat${enabled ? "" : " is-off"}" data-seat-id="${escapeHtml(seat.id)}" style="--h:${seatHue(seat.id)}" aria-labelledby="${base}-name">
    <header class="seat-head">
      <div class="avatar" aria-hidden="true">${escapeHtml(initials(seat.label || seat.id))}</div>
      <div class="seat-title">
        <h3 id="${base}-name">${escapeHtml(seat.label || seat.id)}</h3>
        <p>${escapeHtml(meta)}</p>
      </div>
      <span class="badge auth-unknown" data-auth-badge>—</span>
    </header>
    <div class="seat-tags">${seat.configured && !enabled ? `<span class="chip">disabled</span>` : ""}${sessionNote}</div>
    ${controls}
    <p class="seat-auth-detail hint" data-auth-detail hidden></p>
    <p class="seat-note" data-seat-note role="status" hidden></p>
    <div class="seat-activity">
      <h4>Activity <span class="count" data-activity-count></span></h4>
      <ol class="activity-list" data-activity></ol>
    </div>
  </article>`;
}

function renderSeats() {
  const seats = seatUniverse();
  const inSession = new Set((state.session?.seats ?? []).map((seat) => seat.id));
  preserveFocus(els.seatList, () => {
    els.seatList.innerHTML = seats.length ? seats.map((seat, index) => seatCardHtml(seat, index, inSession)).join("") : `<p class="empty">No seats configured.</p>`;
  });
  state.seatRefs = new Map();
  for (const card of els.seatList.querySelectorAll(".seat")) {
    state.seatRefs.set(card.dataset.seatId, {
      card,
      badge: card.querySelector("[data-auth-badge]"),
      detail: card.querySelector("[data-auth-detail]"),
      note: card.querySelector("[data-seat-note]"),
      activity: card.querySelector("[data-activity]"),
      activityCount: card.querySelector("[data-activity-count]"),
    });
  }
  for (const seat of seats) {
    renderSeatActivity(seat.id);
    renderSeatNote(seat.id);
  }
  renderAuthBadges();
  const problem = state.seatSnapshot?.problem;
  els.seatProblem.textContent = problem ? `Seat configuration problem: ${problem}` : "";
  els.seatProblem.hidden = !problem;
}

function renderSeatActivity(seatId) {
  const ref = state.seatRefs.get(seatId);
  if (!ref) return;
  const messages = state.seatMessages.get(seatId) ?? [];
  ref.activityCount.textContent = messages.length ? String(messages.length) : "";
  if (!state.selectedId) {
    ref.activity.innerHTML = `<li class="empty">Select a session to see this seat's activity.</li>`;
    return;
  }
  if (!messages.length) {
    ref.activity.innerHTML = `<li class="empty">No activity in this session.</li>`;
    return;
  }
  ref.activity.innerHTML = messages
    .slice(-SEAT_ACTIVITY_LIMIT)
    .map((message) => {
      const verdict = message.verdict && typeof message.verdict === "object" ? message.verdict : null;
      const findings = Array.isArray(verdict?.findings) ? verdict.findings.length : 0;
      return `<li>
        <div class="act-head">
          <span class="act-meta">${escapeHtml(messageMeta(message))}</span>
          ${verdictBadge(verdict)}
          ${findings ? `<span class="act-findings">${escapeHtml(plural(findings, "finding"))}</span>` : ""}
        </div>
        <p class="act-text">${escapeHtml(message.text)}</p>
      </li>`;
    })
    .join("");
  ref.activity.scrollTop = ref.activity.scrollHeight;
}

function renderSeatNote(seatId) {
  const ref = state.seatRefs.get(seatId);
  if (!ref) return;
  const note = state.seatNotes.get(seatId);
  ref.note.hidden = !note;
  ref.note.textContent = note?.text ?? "";
  ref.note.dataset.kind = note?.kind ?? "";
}

function setSeatNote(seatId, text, kind) {
  const previous = state.seatNotes.get(seatId);
  if (previous?.timer) clearTimeout(previous.timer);
  if (!text) {
    state.seatNotes.delete(seatId);
  } else {
    const timer = kind === "ok" ? setTimeout(() => setSeatNote(seatId, ""), NOTE_TIMEOUT_MS) : null;
    state.seatNotes.set(seatId, { text, kind, timer });
  }
  renderSeatNote(seatId);
}

function authInfo(seatId) {
  if (state.authLoading) return { cls: "checking", label: "checking…" };
  const status = state.auth.get(seatId);
  if (!status) return { cls: "unknown", label: state.authError ? "unknown" : "—" };
  if (status.healthy) return { cls: "ok", label: "ready" };
  if (status.binaryFound) return { cls: "bad", label: "failing" };
  return { cls: "missing", label: "missing" };
}

function renderAuthBadges() {
  for (const [seatId, ref] of state.seatRefs) {
    const info = authInfo(seatId);
    const status = state.auth.get(seatId);
    ref.badge.className = `badge auth-${info.cls}`;
    ref.badge.textContent = info.label;
    const parts = [];
    if (status?.detail) parts.push(status.detail);
    if (status && !status.healthy && status.loginHint) parts.push(`Fix: ${status.loginHint}`);
    ref.badge.title = parts.join("\n") || "";
    ref.badge.setAttribute("aria-label", `Health: ${info.label}`);
    ref.detail.textContent = parts.join(" · ");
    ref.detail.hidden = parts.length === 0 || state.authLoading;
  }
  let text = "";
  if (state.authLoading) text = "Checking seat health…";
  else if (state.authError) text = `Health check failed: ${state.authError}`;
  else if (state.authCheckedAt) text = `Health checked at ${timeLabel(state.authCheckedAt)}${state.authStale ? " · seat config changed since, Recheck to update" : ""}`;
  els.authChecked.textContent = text;
  els.authChecked.hidden = !text;
}

async function loadSeats() {
  try {
    state.seatSnapshot = await api("/api/seats");
    showFormError(els.seatError, "");
  } catch (error) {
    showFormError(els.seatError, `Could not load seats: ${error.message}`);
  }
  renderSeats();
}

/** Seat health can cost real provider calls, so it is fetched only on load and on Recheck. */
async function loadAuth(refresh) {
  state.authLoading = true;
  els.recheck.disabled = true;
  els.recheck.textContent = "Checking…";
  renderAuthBadges();
  try {
    const result = await api(`/api/auth/status${refresh ? "?refresh=1" : ""}`);
    state.auth = new Map((result?.seats ?? []).map((status) => [status.seat, status]));
    state.authCheckedAt = result?.checkedAt ?? new Date().toISOString();
    state.authStale = false;
    state.authError = null;
  } catch (error) {
    state.authError = error.message;
  } finally {
    state.authLoading = false;
    els.recheck.disabled = false;
    els.recheck.textContent = "Recheck";
    renderAuthBadges();
  }
}

async function updateSeat(seatId, patch, control, revert) {
  // Disabling the control while saving drops its focus; put focus back afterwards.
  const hadFocus = document.activeElement === control;
  const controlId = control.id;
  control.disabled = true;
  setSeatNote(seatId, "Saving…", "info");
  try {
    const snapshot = await api("/api/seats", { method: "PUT", body: JSON.stringify({ id: seatId, ...patch }) });
    // A successful save rewrites the config file, which clears any load problem server-side.
    state.seatSnapshot = { ...snapshot, problem: undefined };
    state.authStale = true;
    showFormError(els.seatError, "");
    setSeatNote(seatId, "Saved. Applies to the next session.", "ok");
    renderSeats();
  } catch (error) {
    revert();
    control.disabled = false;
    setSeatNote(seatId, error.message, "error");
  }
  if (hadFocus) document.getElementById(controlId)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------------------------
// Composer

async function convene(event) {
  event.preventDefault();
  const message = els.message.value.trim();
  const cwd = els.cwd.value.trim() || ".";
  if (!message) {
    showFormError(els.composerError, "Describe the task first.");
    els.message.setAttribute("aria-invalid", "true");
    els.message.focus();
    return;
  }
  showFormError(els.composerError, "");
  els.convene.disabled = true;
  els.convene.textContent = "Convening…";
  try {
    const result = await postJson("/api/chat", { message, cwd });
    writeStorage("conclave.cwd", cwd);
    els.message.value = "";
    await refreshSessions();
    if (result?.sessionId) await selectSession(result.sessionId);
  } catch (error) {
    const prefix = error.status === 409 ? "Council busy: " : error.status === 429 ? "Spend limit: " : "";
    showFormError(els.composerError, `${prefix}${error.message}`);
  } finally {
    els.convene.disabled = false;
    els.convene.textContent = "Convene council";
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring

function wire() {
  els.composer.addEventListener("submit", convene);
  els.composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
  els.message.addEventListener("input", () => {
    els.message.removeAttribute("aria-invalid");
    if (!els.composerError.hidden) showFormError(els.composerError, "");
  });

  els.sessionList.addEventListener("click", (event) => {
    const item = event.target.closest("button[data-id]");
    if (item && item.dataset.id !== state.selectedId) selectSession(item.dataset.id);
  });
  els.loadMore.addEventListener("click", () => {
    state.sessionPages += 1;
    refreshSessions();
  });

  els.summary.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (button) runAction(button.dataset.action, button);
  });

  for (const tab of [els.tabActivity, els.tabDeliberation]) {
    tab.addEventListener("click", () => setTab(tab === els.tabActivity ? "activity" : "deliberation"));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === "Home" ? "activity" : event.key === "End" ? "deliberation" : state.tab === "activity" ? "deliberation" : "activity";
      setTab(target, { focus: true });
    });
  }

  els.scroll.addEventListener("scroll", () => {
    if (state.tab === "activity" && !els.jump.hidden && nearBottom()) els.jump.hidden = true;
  });
  els.jump.addEventListener("click", () => scrollFeedToBottom());

  // <details> toggle does not bubble, but it does pass through the capture phase.
  els.panelDeliberation.addEventListener(
    "toggle",
    (event) => {
      const key = event.target?.dataset?.key;
      if (key) state.detailsOverride.set(key, event.target.open);
    },
    true,
  );
  els.panelDeliberation.addEventListener("click", (event) => {
    const button = event.target.closest(".ruling-form button[type=submit]");
    if (button) button.form.dataset.ruling = button.value;
  });
  els.panelDeliberation.addEventListener("submit", (event) => {
    const form = event.target.closest("form.ruling-form");
    if (!form) return;
    event.preventDefault();
    submitRuling(form, event.submitter?.value ?? form.dataset.ruling);
  });
  els.panelDeliberation.addEventListener("input", (event) => {
    const form = event.target.closest("form.ruling-form");
    if (!form || event.target.tagName !== "TEXTAREA") return;
    state.rulingDrafts.set(form.dataset.cid, event.target.value);
    event.target.removeAttribute("aria-invalid");
    showFormError(form.querySelector(".form-error"), "");
  });

  els.seatList.addEventListener("change", (event) => {
    const card = event.target.closest(".seat");
    if (!card) return;
    const seatId = card.dataset.seatId;
    const seat = state.seatSnapshot?.seats?.find((entry) => entry.id === seatId);
    if (!seat) return;
    const control = event.target;
    if (control.matches("[data-seat-toggle]")) {
      const previous = seat.enabled !== false;
      updateSeat(seatId, { enabled: control.checked }, control, () => (control.checked = previous));
    } else if (control.matches("[data-seat-model]")) {
      const field = control.dataset.seatModel;
      if (field !== "cliModel" && field !== "xeniaModel") return;
      const value = control.value.trim();
      const previous = seat[field] ?? "";
      // Enter and blur can both report the same edit; save it once.
      if (value === previous || control.dataset.pending === value) return;
      control.dataset.pending = value;
      updateSeat(seatId, { [field]: value || null }, control, () => {
        control.value = previous;
        delete control.dataset.pending;
      });
    }
  });
  els.seatList.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches("[data-seat-model]")) {
      event.preventDefault();
      event.target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  els.recheck.addEventListener("click", () => loadAuth(true));

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
}

function pollSessions() {
  refreshSessions();
  // A run driven by another process (e.g. `conclave run` in a terminal) does not broadcast to this
  // server's event stream, so pull its messages directly while it is running.
  if (state.session?.state === "running") catchUpMessages();
}

async function boot() {
  const savedCwd = readStorage("conclave.cwd");
  if (savedCwd) els.cwd.value = savedCwd;
  wire();
  renderStatus();
  loadAuth(false);
  loadUsage();
  await Promise.all([loadSeats(), refreshSessions()]);
  const fromHash = readHash();
  const initial = fromHash || state.sessions[0]?.sessionId;
  if (initial) await selectSession(initial);
  else renderSeats();
  setInterval(pollSessions, SESSION_POLL_MS);
  setInterval(loadUsage, USAGE_POLL_MS);
}

boot();
