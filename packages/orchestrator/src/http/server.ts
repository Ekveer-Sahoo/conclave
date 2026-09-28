import { createReadStream, mkdirSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeatConfig } from "@conclave/core";
import {
  getSessionStatus,
  isSessionActive,
  listSessionHistory,
  listSessionMessages,
  recordHumanRuling,
  recordUserMessage,
  requestCancel,
  resumeCouncil,
  runCouncil,
  sessionAbsolutePaths,
  type CouncilActivity,
} from "../session/autonomousCouncil.js";
import { pendingHumanRulings, sessionState, summarizeDeliberation } from "../store/projections.js";
import { EventStore, newSessionId } from "../store/eventStore.js";
import { SessionRegistry } from "../store/sessionRegistry.js";
import { checkAllSeatHealth, type SeatAuthStatus } from "../auth/authStatus.js";
import { SeatConfigStore } from "./seatConfigStore.js";
import { toClientSession } from "./clientSession.js";
import { toClientMessage } from "./sanitize.js";

const here = dirname(fileURLToPath(import.meta.url));
// Vendored at build time by scripts/copy-public.mjs from packages/web/public (which sits outside
// the pnpm workspace and has no build step of its own) — this path must resolve the same way both
// in the monorepo dev layout and in an installed standalone npm package, so it lives inside this
// package's own directory rather than reaching out to a sibling monorepo package.
const publicDir = resolve(here, "../../public");

// SSE subscribers, scoped per session — a client subscribed to session A must never see session
// B's events. Each connected client tracks its own replay cursor (not a shared per-session one):
// two clients on the same session can join or reconnect at different points in the stream, and a
// shared watermark would let one of them miss events that happened between its catch-up read and
// being added to the broadcast set.
const sessionClients = new Map<string, Set<ServerResponse>>();
const clientCursors = new WeakMap<ServerResponse, number>();

let running = false;
let activeController: AbortController | null = null;
/** The session this server process is currently running, if any — the one /api/cancel aborts. */
let activeSessionId: string | null = null;
// Tracks the currently in-flight council run so shutdown can wait for it to actually settle —
// abort() only signals intent; the run's own cleanup (which may still touch the registry/db) needs
// a few ticks to finish, and closing the registry before that lands would throw on the trailing write.
let activeRunPromise: Promise<unknown> | null = null;
const seatConfigStore = new SeatConfigStore(process.env.CONCLAVE_SEAT_CONFIG_PATH ?? join(homedir(), ".conclave", "seat-config.json"));
// Durable, cross-repository registry mapping sessionId -> the SQLite file that holds it. This is
// the only way session-specific routes resolve a dbPath: never from a client-supplied path, and
// never from an in-process "last used repo" variable (which would make every other repository's
// sessions unreachable, and wouldn't survive a restart until that repo was touched again).
const REGISTRY_PATH = process.env.CONCLAVE_SESSION_REGISTRY_PATH ?? join(homedir(), ".conclave", "registry.db");
// Mutable rather than a `const` singleton: shutdownWebServer() closes it, and startWebServer()
// must be able to reopen a fresh connection on a later start — e.g. a test process (or an embedder)
// that starts, shuts down, and starts again — rather than leaving every later request working
// against an already-closed database.
let sessionRegistry: SessionRegistry | null = new SessionRegistry(REGISTRY_PATH);

function registry(): SessionRegistry {
  if (!sessionRegistry) throw new Error("session registry is not open — server has been shut down");
  return sessionRegistry;
}

function resolveDbPath(sessionId: string): string | undefined {
  return registry().get(sessionId)?.dbPath;
}

/**
 * Seat health is expensive to probe: a CLI seat's check is a real (billed) model call. The UI used
 * to poll it every 15 seconds, which quietly spent hundreds of provider calls an hour. Results are
 * now cached per seat-config version and only re-probed after this TTL or on an explicit refresh.
 */
const AUTH_STATUS_TTL_MS = Number(process.env.CONCLAVE_AUTH_STATUS_TTL_MS ?? 10 * 60_000);
let authStatusCache: { version: number; at: number; seats: SeatAuthStatus[] } | null = null;
let authStatusInFlight: Promise<SeatAuthStatus[]> | null = null;

async function seatHealth(forceRefresh: boolean): Promise<{ seats: SeatAuthStatus[]; checkedAt: string }> {
  const snapshot = seatConfigStore.get();
  const fresh = authStatusCache && authStatusCache.version === snapshot.version && Date.now() - authStatusCache.at < AUTH_STATUS_TTL_MS;
  if (!forceRefresh && fresh && authStatusCache) {
    return { seats: authStatusCache.seats, checkedAt: new Date(authStatusCache.at).toISOString() };
  }
  // Concurrent requests share one probe rather than each spawning a full set of provider calls.
  authStatusInFlight ??= checkAllSeatHealth(snapshot.seats, process.cwd()).finally(() => {
    authStatusInFlight = null;
  });
  const seats = await authStatusInFlight;
  authStatusCache = { version: snapshot.version, at: Date.now(), seats };
  return { seats, checkedAt: new Date(authStatusCache.at).toISOString() };
}

const LIMIT_5H_USD = Number(process.env.CONCLAVE_LIMIT_5H_USD ?? 10);
const LIMIT_WEEKLY_USD = Number(process.env.CONCLAVE_LIMIT_WEEKLY_USD ?? 50);
const HOUR_MS = 3_600_000;
const MAX_MESSAGES_PAGE = 200;
const MAX_SESSIONS_PAGE = 100;

function usageWindow(dbPath: string, windowMs: number) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const store = new EventStore(dbPath);
  try {
    const perSeat = store.usageSince(cutoff);
    const totalUsd = perSeat.reduce((sum, s) => sum + s.costUsd, 0);
    return { perSeat, totalUsd };
  } finally {
    store.close();
  }
}

function sendSse(response: ServerResponse, id: number, event: unknown) {
  response.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** Push every new message for a session (since each client's own last-delivered seq) to that session's SSE clients only. */
function broadcastSessionTail(dbPath: string, sessionId: string, options: { touch?: boolean } = {}) {
  if (options.touch !== false) registry().touch(sessionId);
  const clients = sessionClients.get(sessionId);
  if (!clients || clients.size === 0) return;
  const minCursor = Math.min(...[...clients].map((client) => clientCursors.get(client) ?? 0));
  const fresh = listSessionMessages(dbPath, sessionId, minCursor, MAX_MESSAGES_PAGE);
  if (fresh.length === 0) return;
  const paths = sessionAbsolutePaths(dbPath, sessionId);
  for (const client of clients) {
    const cursor = clientCursors.get(client) ?? 0;
    let delivered = cursor;
    for (const message of fresh) {
      if (message.seq <= cursor) continue;
      sendSse(client, message.seq, toClientMessage(message, paths));
      delivered = message.seq;
    }
    clientCursors.set(client, delivered);
  }
}

function onActivityFor(dbPath: string, sessionId: string): (activity: CouncilActivity) => void {
  return () => broadcastSessionTail(dbPath, sessionId);
}

/**
 * In-process runs push their activity as it happens (onActivityFor), but a session can also be
 * advanced by another process — a `conclave run` in a terminal, or a human ruling from the CLI —
 * whose events only ever land in the SQLite log. Tail the log for every session someone is
 * watching so those reach the browser too. One indexed query per watched session per tick.
 */
const WATCH_TAIL_MS = 1_000;
let watchTimer: ReturnType<typeof setInterval> | null = null;
function tailWatchedSessions(): void {
  for (const sessionId of sessionClients.keys()) {
    try {
      const dbPath = resolveDbPath(sessionId);
      if (dbPath) broadcastSessionTail(dbPath, sessionId, { touch: false });
    } catch {
      // A session whose store is briefly unreadable (mid-write, or deleted) is retried next tick.
    }
  }
}

const MAX_BODY_BYTES = 1_000_000; // generous for a chat message + cwd string, small enough to bound per-request memory

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function body(request: import("node:http").IncomingMessage) {
  let value = "";
  let bytes = 0;
  let oversized = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      // Stop buffering (bounds memory) but keep draining the stream instead of abandoning it — if we
      // stop reading while the client is still mid-write, the socket close races the client's write
      // and it can see EPIPE/ECONNRESET instead of our 413 response. Draining lets its write finish
      // normally so it actually receives the error.
      oversized = true;
      continue;
    }
    value += chunk;
  }
  if (oversized) throw new HttpError(413, "request body too large");
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw new HttpError(400, "malformed JSON body");
  }
}

function contentType(path: string) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

function parsePageParams(url: URL, maxLimit: number) {
  const limitRaw = Number(url.searchParams.get("limit") ?? maxLimit);
  const offsetRaw = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, maxLimit) : maxLimit;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

/** Last-Event-ID: header takes priority per the SSE spec; ?lastEventId= is the fallback for a first manual connect. Malformed values are treated as "from the start". */
function parseLastEventId(request: import("node:http").IncomingMessage, url: URL): number {
  const raw = request.headers["last-event-id"] ?? url.searchParams.get("lastEventId") ?? "0";
  const value = Number.parseInt(Array.isArray(raw) ? raw[0]! : raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function startWebServer(port = 4317) {
  if (!sessionRegistry) sessionRegistry = new SessionRegistry(REGISTRY_PATH);
  if (!watchTimer) {
    watchTimer = setInterval(tailWatchedSessions, WATCH_TAIL_MS);
    watchTimer.unref();
  }
  return createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      // A rejected/oversized body may leave unread bytes on the socket — reusing it via keep-alive
      // would feed those leftover bytes into the next request's parser, so force the connection closed.
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (status === 413) headers.Connection = "close";
      if (!response.headersSent) response.writeHead(status, headers);
      if (status === 413) response.once("finish", () => request.destroy());
      if (!response.writableEnded) response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }).listen(port, "127.0.0.1", () => console.log(`Conclave web: http://127.0.0.1:${port}`));
}

/**
 * Orderly shutdown for a server started by startWebServer. Order matters: abort in-flight work
 * before closing its durable stores (so a straggling write lands on an open db, not a closed one),
 * end every SSE response before calling server.close() (an SSE connection is a never-ending response
 * by design, so server.close() alone would hang forever waiting for it to finish), and only close the
 * registry once nothing can still be writing to it. `timeoutMs` bounds how long we wait for in-flight
 * HTTP requests to finish before force-closing remaining sockets, so shutdown always terminates.
 */
export async function shutdownWebServer(server: import("node:http").Server, timeoutMs = 5000): Promise<void> {
  if (activeController) activeController.abort(new Error("server shutting down"));

  // abort() only signals; the run's own cleanup (which may still write to the registry/db) needs a
  // few ticks to actually stop. Wait for it to settle — bounded, so a run that ignores the abort
  // signal can't hang shutdown forever — before anything below closes the store it was writing to.
  if (activeRunPromise) {
    await Promise.race([activeRunPromise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  for (const clients of sessionClients.values()) {
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // client socket may already be gone — nothing to clean up.
      }
    }
  }
  sessionClients.clear();
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }

  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  const forceClose = setTimeout(() => {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  }, timeoutMs);
  try {
    await closed;
  } finally {
    clearTimeout(forceClose);
  }

  if (sessionRegistry) {
    sessionRegistry.close();
    sessionRegistry = null;
  }
}

async function handleRequest(request: import("node:http").IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    const sessionEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (request.method === "GET" && sessionEventsMatch) {
      const sessionId = sessionEventsMatch[1]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      // Node buffers headers until the first write()/end(); when there is no backlog to replay
      // (e.g. a reconnect whose Last-Event-ID is already caught up), nothing would otherwise be
      // written and the client would hang forever waiting on response headers that never arrive.
      response.flushHeaders();
      const afterSeq = parseLastEventId(request, url);
      const paths = sessionAbsolutePaths(dbPath, sessionId);
      const backlog = listSessionMessages(dbPath, sessionId, afterSeq, MAX_MESSAGES_PAGE);
      for (const message of backlog) sendSse(response, message.seq, toClientMessage(message, paths));
      const tailSeq = backlog.length > 0 ? backlog[backlog.length - 1]!.seq : afterSeq;
      clientCursors.set(response, tailSeq);

      let clients = sessionClients.get(sessionId);
      if (!clients) { clients = new Set(); sessionClients.set(sessionId, clients); }
      clients.add(response);
      request.on("close", () => {
        clients!.delete(response);
        clientCursors.delete(response);
        if (clients!.size === 0) sessionClients.delete(sessionId);
      });
      return;
    }

    const sessionMessagesMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (request.method === "GET" && sessionMessagesMatch) {
      const sessionId = sessionMessagesMatch[1]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      const after = Number(url.searchParams.get("after") ?? 0);
      const { limit } = parsePageParams(url, MAX_MESSAGES_PAGE);
      const paths = sessionAbsolutePaths(dbPath, sessionId);
      const messages = listSessionMessages(dbPath, sessionId, Number.isFinite(after) ? after : 0, limit).map((m) => toClientMessage(m, paths));
      json(response, 200, { messages }); return;
    }

    if (request.method === "GET" && url.pathname === "/api/seats") {
      json(response, 200, { ...seatConfigStore.get(), problem: seatConfigStore.problem() }); return;
    }
    if (request.method === "PUT" && url.pathname === "/api/seats") {
      const patch = await body(request) as { id?: string; enabled?: boolean; cliModel?: string | null; xeniaModel?: string | null };
      const current = seatConfigStore.get().seats;
      const seat = current.find((s) => s.id === patch.id);
      if (!seat) { json(response, 404, { error: `unknown seat: ${patch.id}` }); return; }
      if (patch.enabled === false && seat.id === "claude") { json(response, 400, { error: "Claude must remain enabled: it is the only seat that executes and remediates code changes." }); return; }
      const next: SeatConfig[] = current.map((s) => s.id !== patch.id ? s : {
        ...s,
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : s.enabled,
        cliModel: patch.cliModel !== undefined ? (patch.cliModel || undefined) : s.cliModel,
        xeniaModel: patch.xeniaModel !== undefined ? (patch.xeniaModel || undefined) : s.xeniaModel,
      });
      if (next.some((s) => s.adapter === "xenia" && !s.xeniaModel)) { json(response, 400, { error: "a xenia seat needs a xeniaModel" }); return; }
      const snapshot = seatConfigStore.save(next);
      json(response, 200, snapshot); return;
    }
    if (request.method === "GET" && url.pathname === "/api/auth/status") {
      json(response, 200, await seatHealth(url.searchParams.get("refresh") === "1")); return;
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      // Not session-scoped, so there is no sessionId to resolve through the registry — usage is
      // shown for the most recently active session's repo, falling back to the server's own cwd
      // (yielding zero usage) when no session has been registered yet.
      const usageDbPath = registry().list(1, 0)[0]?.dbPath ?? join(process.cwd(), ".conclave", "events.db");
      const fiveHour = usageWindow(usageDbPath, 5 * HOUR_MS);
      const weekly = usageWindow(usageDbPath, 7 * 24 * HOUR_MS);
      json(response, 200, {
        fiveHour: { ...fiveHour, limitUsd: LIMIT_5H_USD, remainingUsd: Math.max(0, LIMIT_5H_USD - fiveHour.totalUsd) },
        weekly: { ...weekly, limitUsd: LIMIT_WEEKLY_USD, remainingUsd: Math.max(0, LIMIT_WEEKLY_USD - weekly.totalUsd) },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (running) { json(response, 409, { error: "A Conclave session is already running." }); return; }
      const payload = await body(request) as { message?: string; cwd?: string };
      if (typeof payload.message !== "string" || !payload.message.trim()) { json(response, 400, { error: "message is required" }); return; }
      // resolve() only normalizes the string (collapses "..", makes it absolute) — it never touches
      // the filesystem, so a symlinked cwd would register two different dbPaths for the same repo
      // depending on which alias the client sent. realpath() resolves symlinks to the canonical path
      // and, as a side effect, fails fast on a nonexistent target instead of silently mkdir-ing a new
      // tree under a typo'd path.
      let cwd: string;
      try {
        cwd = await realpath(resolve(payload.cwd || process.cwd()));
      } catch {
        json(response, 400, { error: "cwd does not exist or is not accessible" });
        return;
      }
      const cwdStat = await stat(cwd);
      if (!cwdStat.isDirectory()) { json(response, 400, { error: "cwd is not a directory" }); return; }
      const dbPath = join(cwd, ".conclave", "events.db"); await mkdir(dirname(dbPath), { recursive: true });
      const fiveHour = usageWindow(dbPath, 5 * HOUR_MS);
      const weekly = usageWindow(dbPath, 7 * 24 * HOUR_MS);
      if (fiveHour.totalUsd >= LIMIT_5H_USD) { json(response, 429, { error: `5-hour spend limit reached: $${fiveHour.totalUsd.toFixed(2)} of $${LIMIT_5H_USD.toFixed(2)}` }); return; }
      if (weekly.totalUsd >= LIMIT_WEEKLY_USD) { json(response, 429, { error: `weekly spend limit reached: $${weekly.totalUsd.toFixed(2)} of $${LIMIT_WEEKLY_USD.toFixed(2)}` }); return; }
      const sessionId = newSessionId();
      registry().register(sessionId, dbPath, cwd);
      recordUserMessage(dbPath, sessionId, payload.message.trim());
      running = true;
      const controller = new AbortController();
      activeController = controller;
      activeSessionId = sessionId;
      json(response, 202, { accepted: true, sessionId });
      activeRunPromise = runCouncil({ task: payload.message.trim(), cwd, dbPath, sessionId, seats: seatConfigStore.get().seats, onActivity: onActivityFor(dbPath, sessionId), signal: controller.signal }).finally(() => {
        running = false;
        if (activeController === controller) activeController = null;
        activeSessionId = null;
        activeRunPromise = null;
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      // The registry is the only cross-repository index of sessions: iterate its entries (each
      // one remembers which repo's dbPath it lives in) rather than querying a single database, so
      // sessions from every repository — not just the most recently touched one — are listed.
      const { limit, offset } = parsePageParams(url, MAX_SESSIONS_PAGE);
      const entries = registry().list(limit, offset);
      const sessions = [];
      for (const entry of entries) {
        try {
          const proj = getSessionStatus(entry.dbPath, entry.sessionId);
          // phaseOpen alone survives a crash forever — it can't tell "still running elsewhere" apart
          // from "orphaned, needs a resume call". Combine it with the live lock check so clients see
          // that distinction instead of an indefinite, misleading "in progress".
          const live = isSessionActive(entry.dbPath, entry.sessionId);
          const state = sessionState(proj);
          const orphaned = !live && state === "running" && proj.phaseOpen;
          sessions.push({
            sessionId: proj.sessionId,
            task: proj.task,
            state: live ? "running" : state === "running" ? "orphaned" : state,
            outcome: proj.outcome,
            awaitingHumanRuling: pendingHumanRulings(proj).length,
            currentPhase: proj.currentPhase,
            currentRound: proj.currentRound,
            phaseOpen: proj.phaseOpen,
            spentUsd: proj.spentUsd,
            worktreeRemoved: !!proj.worktreeRemoved,
            cancelled: proj.cancelled,
            errored: proj.errored,
            orphaned,
            deliberation: summarizeDeliberation(proj),
          });
        } catch (error) {
          // A registered session whose dbPath is unreadable (e.g. the repo's .conclave directory
          // was deleted) shouldn't take down the whole list — skip just that entry.
        }
      }
      json(response, 200, { sessions });
      return;
    }
    const sessionStatusMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionStatusMatch) {
      const sessionId = sessionStatusMatch[1]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      try {
        const proj = getSessionStatus(dbPath, sessionId);
        // Never the raw projection: it carries absolute paths and unbounded model text.
        json(response, 200, { session: toClientSession(proj, sessionAbsolutePaths(dbPath, sessionId), { running: isSessionActive(dbPath, sessionId) }) });
      } catch (error) {
        json(response, 404, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const sessionResumeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);
    if (request.method === "POST" && sessionResumeMatch) {
      if (running) { json(response, 409, { error: "A Conclave session is already running." }); return; }
      const sessionId = sessionResumeMatch[1]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      running = true;
      const controller = new AbortController();
      activeController = controller;
      activeSessionId = sessionId;
      json(response, 202, { accepted: true, sessionId });
      activeRunPromise = resumeCouncil({ sessionId, dbPath, onActivity: onActivityFor(dbPath, sessionId), signal: controller.signal })
        .catch((error) => {
          // Validation failures (unknown session, missing worktree, lock contention) happen
          // before resumeCouncil records anything itself, so record and broadcast the failure
          // here — durably, through the same path as every other message, not a transient push.
          const store = new EventStore(dbPath);
          try {
            store.append(sessionId, {
              type: "ActivityLogged",
              payload: { kind: "system", message: `Resume failed: ${error instanceof Error ? error.message : String(error)}` },
            });
          } finally {
            store.close();
          }
          broadcastSessionTail(dbPath, sessionId);
        })
        .finally(() => {
          running = false;
          if (activeController === controller) activeController = null;
          activeSessionId = null;
          activeRunPromise = null;
        });
      return;
    }
    const sessionCancelMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
    if (request.method === "POST" && sessionCancelMatch) {
      const sessionId = sessionCancelMatch[1]!;
      if (running && activeController && activeSessionId === sessionId) {
        activeController.abort(new Error("cancelled via the web UI"));
        json(response, 202, { accepted: true }); return;
      }
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      // Running somewhere else (e.g. a `conclave run` in a terminal): ask it to stop itself.
      try {
        requestCancel(dbPath, sessionId);
      } catch (error) {
        json(response, 409, { error: error instanceof Error ? error.message : String(error) }); return;
      }
      json(response, 202, { accepted: true }); return;
    }
    const rulingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/contentions\/([^/]+)\/ruling$/);
    if (request.method === "POST" && rulingMatch) {
      const sessionId = rulingMatch[1]!;
      const contentionId = rulingMatch[2]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      const payload = await body(request) as { ruling?: string; reasoning?: string };
      if (payload.ruling !== "UPHELD" && payload.ruling !== "DISMISSED") { json(response, 400, { error: 'ruling must be "UPHELD" or "DISMISSED"' }); return; }
      if (typeof payload.reasoning !== "string" || !payload.reasoning.trim()) { json(response, 400, { error: "reasoning is required" }); return; }
      try {
        recordHumanRuling({ dbPath, sessionId, contentionId, ruling: payload.ruling, reasoning: payload.reasoning.slice(0, 4000), arbiter: "human (web)" });
      } catch (error) {
        json(response, 409, { error: error instanceof Error ? error.message : String(error) }); return;
      }
      broadcastSessionTail(dbPath, sessionId);
      json(response, 200, { recorded: true, awaitingHumanRuling: pendingHumanRulings(getSessionStatus(dbPath, sessionId)).map((item) => item.contentionId) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/cancel") {
      if (!running || !activeController) { json(response, 409, { error: "No Conclave session is currently running." }); return; }
      activeController.abort(new Error("cancelled via /api/cancel"));
      json(response, 202, { accepted: true });
      return;
    }
    // Everything under /api/ is a known, closed route set handled above — a request that reaches here
    // is either a wrong method on a real endpoint or a bogus path, never a static asset. Short-circuit
    // it as JSON instead of letting it fall into the filesystem lookup below.
    if (url.pathname.startsWith("/api/")) { json(response, 404, { error: "not found" }); return; }
    const relative = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[/\\]+/, "");
    const path = resolve(publicDir, relative);
    // startsWith(publicDir) alone would also admit a sibling directory that merely shares the prefix
    // (e.g. publicDir "/app/public" matching "/app/public-secret/x") — require the exact dir or a path
    // boundary right after it.
    if (path !== publicDir && !path.startsWith(publicDir + sep)) { response.writeHead(403); response.end(); return; }
    try { const info = await stat(path); if (!info.isFile()) throw new Error(); response.writeHead(200, { "Content-Type": contentType(path) }); createReadStream(path).pipe(response); }
    catch { response.writeHead(404); response.end("Not found"); }
}
