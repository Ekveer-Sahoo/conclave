import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeatConfig } from "@conclave/core";
import { ZodError } from "zod";
import {
  ApplyConflictError,
  applySessionChanges,
  getSessionStatus,
  isSessionActive,
  listSessionHistory,
  listSessionMessages,
  recordHumanRuling,
  recordUserMessage,
  requestCancel,
  resumeCouncil,
  runCouncil,
  projectionPaths,
  sessionAbsolutePaths,
  type CouncilActivity,
} from "../session/autonomousCouncil.js";
import { pendingHumanRulings, sessionState, summarizeDeliberation } from "../store/projections.js";
import { EventStore, newSessionId } from "../store/eventStore.js";
import { SessionRegistry } from "../store/sessionRegistry.js";
import { checkAllSeatHealth, checkSeatHealth, probeSeatModel, type SeatAuthStatus } from "../auth/authStatus.js";
import { applyModelOverrides, modelCatalog, type ModelCatalog } from "../seats/modelCatalog.js";
import { inspectRepository } from "../worktree/worktree.js";
import { SeatConfigConflictError, SeatConfigInvalidError, SeatConfigStore } from "./seatConfigStore.js";
import { isResumable, toClientSession } from "./clientSession.js";
import { sanitizeText, toClientMessage } from "./sanitize.js";

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

/** The repository's folder name — enough to tell sessions apart without exposing the full path. */
function repositoryName(repoPathRedacted: string): string {
  return repoPathRedacted.split(/[\\/]/).filter(Boolean).at(-1) ?? repoPathRedacted;
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
let authStatusInFlight: { version: number; promise: Promise<SeatAuthStatus[]> } | null = null;

/**
 * Seat health for the UI. Only an explicit refresh probes CLI seats, because each probe is a billed
 * model call — a page load must never spend money. Without a refresh the last result is returned
 * (flagged `stale` once past the TTL); with no result at all, only the free checks run (a gateway's
 * model list, fake seats) and CLI seats are reported as `unchecked`.
 */
async function seatHealth(forceRefresh: boolean): Promise<{ seats: SeatAuthStatus[]; checkedAt: string | null; stale?: boolean }> {
  const snapshot = seatConfigStore.get();
  const cached = authStatusCache && authStatusCache.version === snapshot.version ? authStatusCache : null;
  if (!forceRefresh && cached) {
    return { seats: cached.seats, checkedAt: new Date(cached.at).toISOString(), stale: Date.now() - cached.at >= AUTH_STATUS_TTL_MS };
  }
  if (!forceRefresh) {
    const seats = await Promise.all(
      snapshot.seats.map((seat) =>
        seat.adapter === "cli"
          ? Promise.resolve<SeatAuthStatus>({
              seat: seat.id,
              adapter: "cli",
              cliCommand: seat.cliCommand ?? seat.id,
              binaryFound: true,
              healthy: false,
              unchecked: true,
              detail: "not checked yet; Recheck runs one small billed call per CLI seat",
              loginHint: "",
            })
          : checkSeatHealth(seat, process.cwd()),
      ),
    );
    return { seats, checkedAt: null };
  }
  // Concurrent requests share one probe rather than each spawning a full set of provider calls — but
  // only a probe of this same configuration: one started before a seat change describes the old seats.
  if (authStatusInFlight && authStatusInFlight.version !== snapshot.version) await authStatusInFlight.promise.catch(() => undefined);
  if (!authStatusInFlight) {
    const started = { version: snapshot.version, promise: checkAllSeatHealth(snapshot.seats, process.cwd()) };
    authStatusInFlight = started;
    void started.promise.catch(() => undefined).finally(() => {
      if (authStatusInFlight === started) authStatusInFlight = null;
    });
  }
  const probe = authStatusInFlight;
  const seats = await probe.promise;
  authStatusCache = { version: probe.version, at: Date.now(), seats };
  return { seats, checkedAt: new Date(authStatusCache.at).toISOString() };
}

/** Model catalogs are cheap but not free to build (a gateway request, a CLI spawn); reuse them briefly. */
const MODEL_CATALOG_TTL_MS = 10 * 60_000;
const modelCatalogCache = new Map<string, { at: number; catalog: ModelCatalog }>();

const LIMIT_5H_USD = Number(process.env.CONCLAVE_LIMIT_5H_USD ?? 10);
const LIMIT_WEEKLY_USD = Number(process.env.CONCLAVE_LIMIT_WEEKLY_USD ?? 50);
const HOUR_MS = 3_600_000;
const MAX_MESSAGES_PAGE = 200;
const MAX_SESSIONS_PAGE = 100;

/**
 * Spend in a rolling window across every repository this server knows about. The limits are
 * account-wide ceilings, so they must be measured account-wide: summing only the current (or most
 * recent) repository's log under-reported spend and let a user exceed them by switching repos.
 */
function usageAcrossRepositories(windowMs: number, extraDbPath?: string) {
  const dbPaths = new Set(registry().list(1000, 0).map((entry) => entry.dbPath));
  if (extraDbPath) dbPaths.add(extraDbPath);
  const perSeat = new Map<string, { seat: string; promptTokens: number; completionTokens: number; costUsd: number }>();
  let totalUsd = 0;
  for (const dbPath of dbPaths) {
    if (!existsSync(dbPath)) continue;
    try {
      const window = usageWindow(dbPath, windowMs);
      totalUsd += window.totalUsd;
      for (const seat of window.perSeat) {
        const entry = perSeat.get(seat.seat) ?? { seat: seat.seat, promptTokens: 0, completionTokens: 0, costUsd: 0 };
        entry.promptTokens += seat.promptTokens;
        entry.completionTokens += seat.completionTokens;
        entry.costUsd += seat.costUsd;
        perSeat.set(seat.seat, entry);
      }
    } catch {
      // An unreadable store is skipped rather than failing the whole meter.
    }
  }
  return { totalUsd, perSeat: [...perSeat.values()], repositories: dbPaths.size };
}

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

async function body(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  // Chunks are joined as bytes before decoding: a multi-byte character can straddle two of them.
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      // Stop buffering (bounds memory) but keep draining the stream instead of abandoning it — if we
      // stop reading while the client is still mid-write, the socket close races the client's write
      // and it can see EPIPE/ECONNRESET instead of our 413 response. Draining lets its write finish
      // normally so it actually receives the error.
      oversized = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) throw new HttpError(413, "request body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "malformed JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "the request body must be a JSON object");
  return parsed as Record<string, unknown>;
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
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.trunc(limitRaw), maxLimit) : maxLimit;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0;
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

/** `~` and `~/…` mean the home directory, as they do in a shell; everything else is resolved as given. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

const MAX_DIR_ENTRIES = 500;

/**
 * The server acts for whoever is at this machine's browser, so every request must come from its own
 * page. Two checks:
 * - `Host` must be this server's own loopback address: a DNS-rebinding page (evil.example resolving
 *   to 127.0.0.1) arrives with its own host name and is refused.
 * - `Origin`, whenever a browser sends one, must be this server: browsers send it on every
 *   cross-site POST (including "simple" no-cors ones that skip a CORS preflight), so a page on any
 *   other site cannot start a billed council, record a ruling, or change seats.
 * - `Sec-Fetch-Site`, which browsers send even on no-cors GETs that carry no Origin (an <img> or
 *   <script> tag), must say the request came from this page or was typed by the user. "same-site"
 *   is refused too: any other port on localhost is the same site.
 * Requests without these headers (curl, the CLI, tests) are unaffected.
 */
function isForeignRequest(request: import("node:http").IncomingMessage): boolean {
  const port = request.socket.localPort;
  const own = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!own.has(String(request.headers.host ?? "").toLowerCase())) return true;
  const site = request.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    return !own.has(new URL(origin).host.toLowerCase());
  } catch {
    return true; // "null" and malformed origins (sandboxed frames, file://) are not this page
  }
}

/**
 * Starts a council from a POST /api/chat. Answers the request itself; returns whether a run was
 * started (the caller holds `running` for it until then).
 */
async function convene(request: import("node:http").IncomingMessage, response: ServerResponse): Promise<boolean> {
  const payload = await body(request) as { message?: string; cwd?: string; models?: Record<string, string | null>; allowDirtySource?: boolean };
  if (typeof payload.message !== "string" || !payload.message.trim()) { json(response, 400, { error: "message is required" }); return false; }
  // resolve() only normalizes the string (collapses "..", makes it absolute) — it never touches
  // the filesystem, so a symlinked cwd would register two different dbPaths for the same repo
  // depending on which alias the client sent. realpath() resolves symlinks to the canonical path
  // and, as a side effect, fails fast on a nonexistent target instead of silently mkdir-ing a new
  // tree under a typo'd path.
  let cwd: string;
  try {
    cwd = await realpath(resolve(expandHome(payload.cwd?.trim() || process.cwd())));
  } catch {
    json(response, 400, { error: "cwd does not exist or is not accessible" });
    return false;
  }
  const cwdStat = await stat(cwd);
  if (!cwdStat.isDirectory()) { json(response, 400, { error: "cwd is not a directory" }); return false; }
  // A git repository (a subfolder means its whole repository) runs on a worktree of itself, and
  // must be clean unless the operator opts in. Any other folder runs on a private snapshot of it.
  const repo = await inspectRepository(cwd);
  if (repo.useRepository && repo.root) {
    if ((repo.changes ?? 0) > 0 && payload.allowDirtySource !== true) {
      json(response, 400, { error: `cwd has uncommitted changes (${repo.changes} file${repo.changes === 1 ? "" : "s"})` }); return false;
    }
    cwd = await realpath(repo.root);
  }
  const dbPath = join(cwd, ".conclave", "events.db"); await mkdir(dirname(dbPath), { recursive: true });
  const fiveHour = usageAcrossRepositories(5 * HOUR_MS, dbPath);
  const weekly = usageAcrossRepositories(7 * 24 * HOUR_MS, dbPath);
  if (fiveHour.totalUsd >= LIMIT_5H_USD) { json(response, 429, { error: `5-hour spend limit reached: $${fiveHour.totalUsd.toFixed(2)} of $${LIMIT_5H_USD.toFixed(2)}` }); return false; }
  if (weekly.totalUsd >= LIMIT_WEEKLY_USD) { json(response, 429, { error: `weekly spend limit reached: $${weekly.totalUsd.toFixed(2)} of $${LIMIT_WEEKLY_USD.toFixed(2)}` }); return false; }
  // Per-council model overrides are validated before anything is recorded, and become part of the
  // session's recorded configuration — so a resume uses the same models.
  let councilSeats = seatConfigStore.get().seats;
  if (payload.models !== undefined) {
    if (!payload.models || typeof payload.models !== "object" || Array.isArray(payload.models)) { json(response, 400, { error: "models must be an object of seat id to model" }); return false; }
    try {
      councilSeats = applyModelOverrides(councilSeats, payload.models);
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) }); return false;
    }
  }
  const sessionId = newSessionId();
  registry().register(sessionId, dbPath, cwd);
  recordUserMessage(dbPath, sessionId, payload.message.trim());
  const controller = new AbortController();
  activeController = controller;
  activeSessionId = sessionId;
  json(response, 202, { accepted: true, sessionId });
  activeRunPromise = runCouncil({ task: payload.message.trim(), cwd, dbPath, sessionId, seats: councilSeats, allowDirtySource: payload.allowDirtySource === true, onActivity: onActivityFor(dbPath, sessionId), signal: controller.signal })
    // A run that fails before it records anything itself (a seat configuration it refuses, a file
    // that appeared since the check above) must end the session visibly — and never reject
    // unhandled, which would take the whole server down with it.
    .catch((error) => recordRunFailure(dbPath, sessionId, "The council could not start", error, { terminal: true }))
    .finally(() => {
      running = false;
      if (activeController === controller) activeController = null;
      activeSessionId = null;
      activeRunPromise = null;
    });
  return true;
}

/**
 * Records why a background run failed, durably and through the same path as every other message.
 * Best effort: if the session's store itself is unreachable there is nowhere to record it, and that
 * must not become an unhandled rejection.
 */
function recordRunFailure(dbPath: string, sessionId: string, what: string, error: unknown, options: { terminal?: boolean } = {}): void {
  const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
  try {
    const store = new EventStore(dbPath);
    try {
      store.append(sessionId, { type: "ActivityLogged", payload: { kind: "system", message } });
      if (options.terminal) store.append(sessionId, { type: "SessionErrored", payload: { message, fatal: true } });
    } finally {
      store.close();
    }
    broadcastSessionTail(dbPath, sessionId);
  } catch (recordError) {
    console.error(`Conclave web: ${message} (and it could not be recorded: ${recordError instanceof Error ? recordError.message : String(recordError)})`);
  }
}

async function handleRequest(request: import("node:http").IncomingMessage, response: ServerResponse) {
    if (isForeignRequest(request)) { json(response, 403, { error: "requests must come from Conclave's own page" }); return; }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    // --- Choosing a repository: browse folders, inspect one, list recently used ones ------------
    if (request.method === "GET" && url.pathname === "/api/fs/dirs") {
      let path: string;
      try {
        path = await realpath(resolve(expandHome(url.searchParams.get("path") || "~")));
        if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
      } catch {
        json(response, 404, { error: "that folder doesn't exist or isn't accessible" }); return;
      }
      let names: string[] = [];
      try {
        const listing = (await readdir(path, { withFileTypes: true })).filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules");
        // A symlink to a folder (e.g. /tmp, or a linked project) is browsable like the folder itself.
        const isFolder = async (entry: (typeof listing)[number]) =>
          entry.isDirectory() || (entry.isSymbolicLink() && (await stat(join(path, entry.name)).then((info) => info.isDirectory(), () => false)));
        const flags = await Promise.all(listing.map(isFolder));
        names = listing.filter((_, index) => flags[index]).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
      } catch {
        // Unreadable folder: show it with no children rather than failing the whole browser.
      }
      const entries = names.slice(0, MAX_DIR_ENTRIES).map((name) => ({ name, path: join(path, name), isGitRepo: existsSync(join(path, name, ".git")) }));
      json(response, 200, { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), isGitRepo: existsSync(join(path, ".git")), entries, truncated: names.length > MAX_DIR_ENTRIES });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/fs/repo") {
      const raw = url.searchParams.get("path") || "";
      if (!raw.trim()) { json(response, 400, { error: "path is required" }); return; }
      let path = resolve(expandHome(raw.trim()));
      try { path = await realpath(path); } catch { /* reported as not existing below */ }
      const info = await inspectRepository(path);
      // "git": runs on a worktree of the repository. "folder": runs on a private snapshot of it.
      const kind = info.useRepository ? "git" : info.isDirectory ? "folder" : undefined;
      json(response, 200, { ...info, kind }); return;
    }
    if (request.method === "GET" && url.pathname === "/api/repos/recent") {
      // Repositories councils have run in, most recent first, from the registry (which stores them
      // with the home directory abbreviated to "~").
      const seen = new Set<string>();
      const repos: Array<{ path: string; name: string; lastUsed: string }> = [];
      for (const entry of registry().list(500, 0)) {
        const path = expandHome(entry.repoPathRedacted);
        if (seen.has(path) || !existsSync(path)) continue;
        seen.add(path);
        repos.push({ path, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, lastUsed: entry.updatedAt });
        if (repos.length >= 8) break;
      }
      json(response, 200, { repos, home: homedir() }); return;
    }

    const sessionEventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (request.method === "GET" && sessionEventsMatch) {
      const sessionId = sessionEventsMatch[1]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath || !existsSync(dbPath)) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      // Read before the 200 goes out: a failure here must be an error status (which EventSource
      // stops on), not an event stream that closes at once and is reconnected forever.
      const afterSeq = parseLastEventId(request, url);
      let paths: ReturnType<typeof sessionAbsolutePaths>;
      let backlog: ReturnType<typeof listSessionMessages>;
      try {
        paths = sessionAbsolutePaths(dbPath, sessionId);
        backlog = listSessionMessages(dbPath, sessionId, afterSeq, MAX_MESSAGES_PAGE);
      } catch (error) {
        json(response, 404, { error: error instanceof Error ? error.message : String(error) }); return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      // Node buffers headers until the first write()/end(); when there is no backlog to replay
      // (e.g. a reconnect whose Last-Event-ID is already caught up), nothing would otherwise be
      // written and the client would hang forever waiting on response headers that never arrive.
      response.flushHeaders();
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
      // A GET never creates a store: a registered session whose events.db is gone is simply unknown now.
      if (!dbPath || !existsSync(dbPath)) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      const after = Number(url.searchParams.get("after") ?? 0);
      const { limit } = parsePageParams(url, MAX_MESSAGES_PAGE);
      const paths = sessionAbsolutePaths(dbPath, sessionId);
      const messages = listSessionMessages(dbPath, sessionId, Number.isFinite(after) ? after : 0, limit).map((m) => toClientMessage(m, paths));
      json(response, 200, { messages }); return;
    }

    if (request.method === "GET" && url.pathname === "/api/seats") {
      json(response, 200, { ...seatConfigStore.get(), problem: seatConfigStore.problem(), warnings: seatConfigStore.warnings() }); return;
    }
    if (request.method === "PUT" && url.pathname === "/api/seats") {
      const patch = await body(request) as { id?: string; enabled?: boolean; cliModel?: string | null; xeniaModel?: string | null };
      for (const field of ["cliModel", "xeniaModel"] as const) {
        const value = patch[field];
        if (value !== undefined && value !== null && typeof value !== "string") { json(response, 400, { error: `${field} must be a string or null` }); return; }
      }
      if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") { json(response, 400, { error: "enabled must be true or false" }); return; }
      const { version, seats: current } = seatConfigStore.get();
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
      try {
        json(response, 200, seatConfigStore.save(next, { expectedVersion: version }));
      } catch (error) {
        if (error instanceof SeatConfigInvalidError || error instanceof SeatConfigConflictError) { json(response, 409, { error: error.message }); return; }
        if (error instanceof ZodError) { json(response, 400, { error: `invalid seat setting: ${error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}` }); return; }
        throw error;
      }
      return;
    }
    const seatModelsMatch = url.pathname.match(/^\/api\/seats\/([^/]+)\/models$/);
    if (request.method === "GET" && seatModelsMatch) {
      const seat = seatConfigStore.get().seats.find((s) => s.id === seatModelsMatch[1]);
      if (!seat) { json(response, 404, { error: `unknown seat: ${seatModelsMatch[1]}` }); return; }
      const key = `${seat.id}\u0000${seat.adapter}\u0000${seat.cliCommand ?? ""}`;
      const cached = modelCatalogCache.get(key);
      const fresh = cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS && url.searchParams.get("refresh") !== "1";
      const catalog = fresh ? cached.catalog : await modelCatalog(seat);
      if (!fresh && !catalog.error) modelCatalogCache.set(key, { at: Date.now(), catalog });
      // `current` always reflects the saved config, even when the list itself is cached.
      json(response, 200, { ...catalog, current: seat.adapter === "xenia" ? seat.xeniaModel : seat.adapter === "cli" ? seat.cliModel : undefined });
      return;
    }
    const seatTestMatch = url.pathname.match(/^\/api\/seats\/([^/]+)\/test$/);
    if (request.method === "POST" && seatTestMatch) {
      const seat = seatConfigStore.get().seats.find((s) => s.id === seatTestMatch[1]);
      if (!seat) { json(response, 404, { error: `unknown seat: ${seatTestMatch[1]}` }); return; }
      const payload = await body(request) as { model?: string | null };
      if (payload.model !== undefined && payload.model !== null && typeof payload.model !== "string") { json(response, 400, { error: "model must be a string" }); return; }
      // One real, tiny, billed call with exactly the model and flags a run would use — only ever on
      // this explicit request.
      json(response, 200, await probeSeatModel(seat, payload.model ?? undefined, process.cwd()));
      return;
    }
    if (url.pathname === "/api/auth/status" && (request.method === "GET" || request.method === "POST")) {
      // Only a POST re-probes: a probe is a billed call per CLI seat, and a GET must never spend.
      json(response, 200, await seatHealth(request.method === "POST")); return;
    }
    if (request.method === "GET" && url.pathname === "/api/usage") {
      // Not session-scoped, so there is no sessionId to resolve through the registry — usage is
      // shown for the most recently active session's repo, falling back to the server's own cwd
      // (yielding zero usage) when no session has been registered yet.
      const fiveHour = usageAcrossRepositories(5 * HOUR_MS);
      const weekly = usageAcrossRepositories(7 * 24 * HOUR_MS);
      json(response, 200, {
        fiveHour: { ...fiveHour, limitUsd: LIMIT_5H_USD, remainingUsd: Math.max(0, LIMIT_5H_USD - fiveHour.totalUsd) },
        weekly: { ...weekly, limitUsd: LIMIT_WEEKLY_USD, remainingUsd: Math.max(0, LIMIT_WEEKLY_USD - weekly.totalUsd) },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      if (running) { json(response, 409, { error: "A Conclave session is already running." }); return; }
      // Claimed before the first await, so two convenes (or a convene and a resume) arriving together
      // cannot both pass the check above. Released unless a run actually starts.
      running = true;
      let started = false;
      try {
        started = await convene(request, response);
      } finally {
        if (!started) running = false;
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sessions") {
      // The registry is the only cross-repository index of sessions: iterate its entries (each
      // one remembers which repo's dbPath it lives in) rather than querying a single database, so
      // sessions from every repository — not just the most recently touched one — are listed.
      const { limit, offset } = parsePageParams(url, MAX_SESSIONS_PAGE);
      // One more than asked for, so the client learns whether another page exists even when an
      // unreadable entry below is skipped and this page comes back short.
      const entries = registry().list(limit + 1, offset);
      const hasMore = entries.length > limit;
      const sessions = [];
      for (const entry of entries.slice(0, limit)) {
        try {
          if (!existsSync(entry.dbPath)) continue;
          const proj = getSessionStatus(entry.dbPath, entry.sessionId);
          // phaseOpen alone survives a crash forever — it can't tell "still running elsewhere" apart
          // from "orphaned, needs a resume call". Combine it with the live lock check so clients see
          // that distinction instead of an indefinite, misleading "in progress". A run this server just
          // started counts as live before it has taken its lock.
          const live = activeSessionId === entry.sessionId || isSessionActive(entry.dbPath, entry.sessionId);
          const state = sessionState(proj);
          const orphaned = !live && state === "running" && proj.phaseOpen;
          sessions.push({
            sessionId: proj.sessionId,
            repo: repositoryName(entry.repoPathRedacted),
            startedAt: proj.startedAt,
            updatedAt: proj.updatedAt ?? entry.updatedAt,
            task: proj.task === undefined ? undefined : sanitizeText(proj.task, projectionPaths(proj)),
            state: live ? "running" : state === "running" ? "orphaned" : state,
            resumable: isResumable(proj, live),
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
      json(response, 200, { sessions, hasMore, nextOffset: offset + limit });
      return;
    }
    const sessionStatusMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (request.method === "GET" && sessionStatusMatch) {
      const sessionId = sessionStatusMatch[1]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath || !existsSync(dbPath)) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      try {
        const proj = getSessionStatus(dbPath, sessionId);
        // Never the raw projection: it carries absolute paths and unbounded model text.
        const entry = registry().get(sessionId);
        json(response, 200, { session: toClientSession(proj, projectionPaths(proj), { running: activeSessionId === sessionId || isSessionActive(dbPath, sessionId), repo: entry ? repositoryName(entry.repoPathRedacted) : undefined }) });
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
        // Validation failures (unknown session, missing worktree, lock contention) happen before
        // resumeCouncil records anything itself, so record and broadcast the failure here.
        .catch((error) => recordRunFailure(dbPath, sessionId, "Resume failed", error))
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
    const applyMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/apply$/);
    if (request.method === "POST" && applyMatch) {
      const sessionId = applyMatch[1]!;
      const dbPath = resolveDbPath(sessionId);
      if (!dbPath) { json(response, 404, { error: `unknown session: ${sessionId}` }); return; }
      const payload = await body(request) as { check?: boolean };
      try {
        const { files } = await applySessionChanges({ dbPath, sessionId, check: payload.check === true });
        if (payload.check !== true) broadcastSessionTail(dbPath, sessionId);
        json(response, 200, { applied: payload.check !== true, files });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(response, error instanceof ApplyConflictError ? 409 : 400, { error: sanitizeText(message, sessionAbsolutePaths(dbPath, sessionId)), conflict: error instanceof ApplyConflictError });
      }
      return;
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
    try { const info = await stat(path); if (!info.isFile()) throw new Error(); } catch { response.writeHead(404); response.end("Not found"); return; }
    // A file can vanish or become unreadable between stat and open (a rebuild replaces public/):
    // that must end this response, never surface as an unhandled stream error.
    response.writeHead(200, { "Content-Type": contentType(path) });
    await pipeline(createReadStream(path), response).catch(() => response.destroy());
}
