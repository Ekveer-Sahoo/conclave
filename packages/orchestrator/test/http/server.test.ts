import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { before } from "node:test";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { SeatConfig } from "@conclave/core";
import { EventStore } from "../../src/store/eventStore.ts";
import { SeatConfigStore } from "../../src/http/seatConfigStore.ts";
import { SessionRegistry } from "../../src/store/sessionRegistry.ts";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  // The web server writes its durable event db to <cwd>/.conclave/events.db before the
  // council's clean-repository check runs, so a real conclave-enabled repo is expected to
  // gitignore that directory (mirrored here, matching intended real-world setup).
  await writeFile(join(dir, ".gitignore"), ".conclave/\n");
  await execFileAsync("git", ["add", ".gitignore"], { cwd: dir });
  await execFileAsync("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "init"], { cwd: dir });
}

async function makeFakeProvider(scratch: string): Promise<string> {
  const provider = join(scratch, "provider.mjs");
  await writeFile(provider, `
const id = process.argv[2];
console.log(JSON.stringify({seat:id,findings:[],overall_verdict:"APPROVE",verdict_reasoning:"ok",raw_usage:{promptTokens:1,completionTokens:2}}));
`);
  return provider;
}

// The web server's seat configuration singleton is loaded once at module-import time from a
// durable file (real path defaults to ~/.conclave/seat-config.json). To drive fast, deterministic
// tests without invoking real claude/codex/antigravity CLIs — and without ever touching the
// developer's real home-directory config — point CONCLAVE_SEAT_CONFIG_PATH at a throwaway temp
// file seeded with a fake provider *before* dynamically importing the server module.
let startWebServer: (port?: number) => import("node:http").Server;
let shutdownWebServer: (server: import("node:http").Server, timeoutMs?: number) => Promise<void>;
// The durable global session registry (see src/store/sessionRegistry.ts) is also a module-import-
// time singleton, backed by a real SQLite file. Point it at a throwaway temp path for the same
// reasons as the seat config above — and so tests can open a second, independent SessionRegistry
// instance against the same file to prove sessions survive a real process restart.
let registryPath: string;

before(async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-http-seats-"));
  const provider = await makeFakeProvider(scratch);
  const configPath = join(scratch, "seat-config.json");
  const seat = (id: string): SeatConfig => ({
    id,
    label: id,
    adapter: "cli",
    cliCommand: process.execPath,
    cliArgsTemplate: [provider, id, "{prompt}"],
    role: "CORRECTNESS",
    temperature: 0.2,
    maxTokens: 100,
    timeoutMs: 5_000,
    enabled: true,
    tier: "standard",
  });
  new SeatConfigStore(configPath).save([seat("claude"), seat("codex"), seat("antigravity")]);
  process.env.CONCLAVE_SEAT_CONFIG_PATH = configPath;
  registryPath = join(scratch, "registry.db");
  process.env.CONCLAVE_SESSION_REGISTRY_PATH = registryPath;
  // Plain folders run on private snapshots; keep those out of the developer's real ~/.conclave.
  process.env.CONCLAVE_SNAPSHOT_DIR = join(scratch, "snapshots");

  ({ startWebServer, shutdownWebServer } = await import("../../dist/http/server.js"));
});

async function startTestServer(): Promise<{ base: string; close: () => Promise<void>; server: import("node:http").Server }> {
  const server = startWebServer(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    server,
  };
}

async function openSse(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { headers });
}

/** Read a bounded number of SSE frames (or until timeoutMs elapses) from a fetch Response body. */
async function readSseFrames(response: Response, opts: { count?: number; timeoutMs?: number } = {}): Promise<{ id: number; data: unknown }[]> {
  const { count = Infinity, timeoutMs = 2_000 } = opts;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { id: number; data: unknown }[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (frames.length < count && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), remaining)),
    ]);
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const idLine = chunk.split("\n").find((l) => l.startsWith("id: "));
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (idLine && dataLine) {
        frames.push({ id: Number(idLine.slice(4)), data: JSON.parse(dataLine.slice(6)) });
      }
      if (frames.length >= count) break;
    }
  }
  await reader.cancel().catch(() => {});
  return frames;
}

async function runOneChat(base: string, cwd: string, message: string): Promise<string> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, cwd }),
  });
  assert.equal(res.status, 202);
  const { sessionId } = (await res.json()) as { sessionId: string };
  // Wait for the (fast, fake-provider-backed) council run to finish and durably persist events.
  for (let i = 0; i < 100; i++) {
    const statusRes = await fetch(`${base}/api/sessions/${sessionId}`);
    if (statusRes.status === 200) {
      const { session } = (await statusRes.json()) as { session: { state?: string } };
      if (session.state && !["running", "orphaned"].includes(session.state)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return sessionId;
}

test("restart recovery: durable messages survive a fresh server/process (queried straight from disk)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-restart-"));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  let sessionId = "";
  try {
    sessionId = await runOneChat(base, dir, "restart recovery test task");
    const res = await fetch(`${base}/api/sessions/${sessionId}/messages`);
    assert.equal(res.status, 200);
    const { messages } = (await res.json()) as { messages: { kind: string; text?: string }[] };
    assert.ok(messages.length > 0, "durable messages must be present");
    assert.ok(messages.some((m) => m.kind === "user" && m.text === "restart recovery test task"));
  } finally {
    await close();
  }

  // Prove the durable registry itself (not just the events database) survives a restart: open a
  // brand new SessionRegistry instance against the same on-disk registry file, independent of
  // anything the server process kept in memory, and confirm it still resolves the session.
  const freshRegistry = new SessionRegistry(registryPath);
  try {
    const entry = freshRegistry.get(sessionId);
    assert.ok(entry, "a fresh SessionRegistry instance must resolve the session from disk alone");
    assert.equal(entry!.sessionId, sessionId);
  } finally {
    freshRegistry.close();
  }

  // Simulate a server restart: the previous process (and any in-memory-only state it held) is
  // gone; a brand new process/server must still recover the same session's messages straight from
  // the durable registry and SQLite file on disk — with NO further chat call needed to "learn"
  // which repo the session lives in.
  const restarted = await startTestServer();
  try {
    const res2 = await fetch(`${restarted.base}/api/sessions/${sessionId}/messages`);
    assert.equal(res2.status, 200);
    const { messages: messages2 } = (await res2.json()) as { messages: { kind: string; text?: string }[] };
    assert.ok(
      messages2.some((m) => m.kind === "user" && m.text === "restart recovery test task"),
      "pre-restart durable messages must still be recoverable after the process restarts, with no additional chat call",
    );

    const statusRes = await fetch(`${restarted.base}/api/sessions/${sessionId}`);
    assert.equal(statusRes.status, 200, "session status must resolve via the registry alone after restart");
  } finally {
    await restarted.close();
  }
});

test("multi-repository session discovery: sessions in different repositories are all resolvable through the registry", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "conclave-http-repoA-"));
  const dirB = await mkdtemp(join(tmpdir(), "conclave-http-repoB-"));
  await initRepo(dirA);
  await initRepo(dirB);

  const { base, close } = await startTestServer();
  try {
    const sessionIdA = await runOneChat(base, dirA, "task in repo A");
    const sessionIdB = await runOneChat(base, dirB, "task in repo B");
    assert.notEqual(sessionIdA, sessionIdB);

    // The history list must surface sessions from BOTH repositories, not just the most recently
    // touched one (repo B) — that was exactly the bug a single mutable lastDbPath caused.
    const listRes = await fetch(`${base}/api/sessions?limit=20&offset=0`);
    assert.equal(listRes.status, 200);
    const { sessions } = (await listRes.json()) as { sessions: { sessionId: string; task: string }[] };
    const ids = sessions.map((s) => s.sessionId);
    assert.ok(ids.includes(sessionIdA), "session from repo A must be listed");
    assert.ok(ids.includes(sessionIdB), "session from repo B must be listed");

    // Per-session routes must resolve each session against its OWN repository's database, even
    // though repo A was not the most recently active one.
    const messagesA = await fetch(`${base}/api/sessions/${sessionIdA}/messages`);
    assert.equal(messagesA.status, 200);
    const { messages: msgsA } = (await messagesA.json()) as { messages: { kind: string; text?: string }[] };
    assert.ok(msgsA.some((m) => m.kind === "user" && m.text === "task in repo A"));

    const messagesB = await fetch(`${base}/api/sessions/${sessionIdB}/messages`);
    assert.equal(messagesB.status, 200);
    const { messages: msgsB } = (await messagesB.json()) as { messages: { kind: string; text?: string }[] };
    assert.ok(msgsB.some((m) => m.kind === "user" && m.text === "task in repo B"));

    const statusA = await fetch(`${base}/api/sessions/${sessionIdA}`);
    assert.equal(statusA.status, 200, "status for repo A's session must resolve even though repo B was touched most recently");
  } finally {
    await close();
  }
});

test("configuration restoration: seat config persists across a fresh SeatConfigStore instance (simulated restart)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-seatcfg-"));
  const path = join(dir, "seat-config.json");
  const store1 = new SeatConfigStore(path);
  const before = store1.get();
  const next = before.seats.map((s) => (s.id === "codex" ? { ...s, enabled: false } : s));
  const saved = store1.save(next);
  assert.equal(saved.version, before.version + 1);

  // A fresh instance pointed at the same file simulates a process restart: no module-level state
  // is shared, only the file on disk.
  const store2 = new SeatConfigStore(path);
  const restored = store2.get();
  assert.equal(restored.version, saved.version);
  assert.equal(restored.seats.find((s) => s.id === "codex")?.enabled, false);
});

test("session isolation: messages and SSE streams for one session never include another session's events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-isolation-"));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  try {
    const sessionA = await runOneChat(base, dir, "session A task");
    const dbPath = join(dir, ".conclave", "events.db");
    // Seed a second session directly (bypassing a real council run) to test isolation cheaply.
    const store = new EventStore(dbPath);
    const sessionB = "session-b-isolated";
    store.append(sessionB, { type: "SessionCreated", payload: { sessionId: sessionB, task: "session B task", budgetCeilingUsd: 5, minQuorum: 3 } });
    store.append(sessionB, { type: "UserMessagePosted", payload: { text: "session B secret task" } });
    store.close();
    // Session-specific routes now resolve dbPath exclusively through the durable registry, so a
    // session seeded directly into the events file (bypassing a real /api/chat call) must also be
    // registered directly, mirroring what a real session creation would have done.
    const registry = new SessionRegistry(registryPath);
    registry.register(sessionB, dbPath, dir);
    registry.close();

    const resA = await fetch(`${base}/api/sessions/${sessionA}/messages`);
    const { messages: messagesA } = (await resA.json()) as { messages: { text?: string }[] };
    assert.ok(!messagesA.some((m) => m.text === "session B secret task"), "session A must not see session B's messages");

    const resB = await fetch(`${base}/api/sessions/${sessionB}/messages`);
    const { messages: messagesB } = (await resB.json()) as { messages: { text?: string }[] };
    assert.ok(messagesB.some((m) => m.text === "session B secret task"));
    assert.ok(!messagesB.some((m) => m.text === "session A task"), "session B must not see session A's messages");
  } finally {
    await close();
  }
});

test("SSE reconnection with Last-Event-ID replays only new events, without duplication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-sse-"));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  try {
    const sessionId = await runOneChat(base, dir, "sse reconnection task");

    const first = await openSse(`${base}/api/sessions/${sessionId}/events`);
    const framesFirst = await readSseFrames(first, { timeoutMs: 1_000 });
    assert.ok(framesFirst.length > 0, "initial connect must replay backlog");
    const lastId = framesFirst[framesFirst.length - 1]!.id;

    const second = await openSse(`${base}/api/sessions/${sessionId}/events`, { "Last-Event-ID": String(lastId) });
    const framesSecond = await readSseFrames(second, { timeoutMs: 500 });
    const idsSecond = framesSecond.map((f) => f.id);
    assert.ok(idsSecond.every((id) => id > lastId), "reconnect must not replay events already seen");
    assert.equal(new Set(idsSecond).size, idsSecond.length, "no duplicate event ids on reconnect");
  } finally {
    await close();
  }
});

test("malformed Last-Event-ID / cursor values degrade gracefully to full replay instead of erroring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-malformed-"));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  try {
    const sessionId = await runOneChat(base, dir, "malformed cursor task");

    const withGarbageHeader = await openSse(`${base}/api/sessions/${sessionId}/events`, { "Last-Event-ID": "not-a-number" });
    const frames1 = await readSseFrames(withGarbageHeader, { timeoutMs: 800 });
    assert.ok(frames1.length > 0, "malformed Last-Event-ID must fall back to replay-from-start, not error/empty stream");

    const withGarbageQuery = await openSse(`${base}/api/sessions/${sessionId}/events?lastEventId=%%%`);
    const frames2 = await readSseFrames(withGarbageQuery, { timeoutMs: 800 });
    assert.ok(frames2.length > 0, "malformed ?lastEventId= must also fall back gracefully");

    const messagesRes = await fetch(`${base}/api/sessions/${sessionId}/messages?after=not-a-number`);
    assert.equal(messagesRes.status, 200, "malformed ?after= on the messages endpoint must not error");
  } finally {
    await close();
  }
});

test("concurrent clients on the same session each receive the full event stream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-concurrent-"));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  try {
    const sessionId = await runOneChat(base, dir, "concurrent clients task");

    const [resA, resB] = await Promise.all([
      openSse(`${base}/api/sessions/${sessionId}/events`),
      openSse(`${base}/api/sessions/${sessionId}/events`),
    ]);
    const [framesA, framesB] = await Promise.all([
      readSseFrames(resA, { timeoutMs: 1_000 }),
      readSseFrames(resB, { timeoutMs: 1_000 }),
    ]);
    assert.ok(framesA.length > 0);
    assert.ok(framesB.length > 0);
    assert.deepEqual(framesA.map((f) => f.id), framesB.map((f) => f.id), "both concurrent clients must see the same backlog");
  } finally {
    await close();
  }
});

test("POST /api/chat rejects a cwd that does not exist", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-http-badpath-"));
  const { base, close } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", cwd: join(scratch, "does-not-exist") }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /api/chat rejects a cwd that is a file, not a directory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "conclave-http-filepath-"));
  const filePath = join(scratch, "not-a-dir.txt");
  await writeFile(filePath, "hello");
  const { base, close } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", cwd: filePath }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /api/chat resolves a symlinked cwd to its canonical target so the registry never splits one repo across two dbPaths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-real-"));
  await initRepo(dir);
  const scratch = await mkdtemp(join(tmpdir(), "conclave-http-link-"));
  const link = join(scratch, "repo-link");
  await symlink(dir, link, "dir");
  const { base, close } = await startTestServer();
  try {
    const sessionId = await runOneChat(base, link, "symlinked cwd task");
    const registry = new SessionRegistry(registryPath);
    try {
      const entry = registry.get(sessionId);
      assert.ok(entry, "session must be registered");
      const canonicalDir = await realpath(dir);
      assert.ok(
        entry!.repoPathRedacted.endsWith(canonicalDir.split("/").pop()!),
        "registered repo path should reflect the symlink-resolved directory",
      );
      // Registering via the symlink alias again must resolve to the SAME canonical dbPath, not a
      // second sibling tree keyed off the link — proving realpath() dedupes symlink aliases.
      const sessionId2 = await runOneChat(base, dir, "same repo via real path");
      const entry2 = registry.get(sessionId2);
      assert.equal(entry2!.dbPath, entry!.dbPath, "symlink and real path must resolve to the same durable dbPath");
    } finally {
      registry.close();
    }
  } finally {
    await close();
  }
});

test("static file serving refuses path traversal outside the public directory, including percent-encoded and sibling-prefix attempts", async () => {
  const { base, close } = await startTestServer();
  try {
    const traversal = await fetch(`${base}/../../../../etc/passwd`);
    assert.notEqual(traversal.status, 200);

    const encoded = await fetch(`${base}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`);
    assert.notEqual(encoded.status, 200);

    const doubleEncoded = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
    assert.notEqual(doubleEncoded.status, 200);
  } finally {
    await close();
  }
});

test("POST /api/chat with a malformed JSON body returns 400, not a crash or a raw 500 stack trace", async () => {
  const { base, close } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not valid json at all",
    });
    assert.equal(res.status, 400);
    const payload = (await res.json()) as { error: string };
    assert.ok(payload.error);

    // The server must still be alive and serving other requests after a malformed body.
    const health = await fetch(`${base}/api/sessions`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test("POST /api/chat with a non-object JSON body (e.g. a bare string or array) does not crash the handler", async () => {
  const { base, close } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("just a string, not an object"),
    });
    // Whatever status it returns, it must be a controlled response, not a hang or connection reset.
    assert.ok(res.status >= 400 && res.status < 600);

    const health = await fetch(`${base}/api/sessions`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test("POST /api/chat rejects an oversized request body instead of buffering it unbounded", async () => {
  const { base, close } = await startTestServer();
  try {
    const huge = JSON.stringify({ message: "x".repeat(2_000_000), cwd: process.cwd() });
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 413);

    // The server must still be alive and serving other requests after an oversized body.
    const health = await fetch(`${base}/api/sessions`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test("unsupported HTTP methods against known API routes return a controlled JSON 404/405, never a crash or a filesystem 500", async () => {
  const { base, close } = await startTestServer();
  try {
    const del = await fetch(`${base}/api/chat`, { method: "DELETE" });
    assert.ok(del.status === 404 || del.status === 405);

    const patch = await fetch(`${base}/api/seats`, { method: "PATCH" });
    assert.ok(patch.status === 404 || patch.status === 405);

    const put = await fetch(`${base}/api/sessions`, { method: "PUT" });
    assert.ok(put.status === 404 || put.status === 405);

    const health = await fetch(`${base}/api/sessions`);
    assert.equal(health.status, 200);
  } finally {
    await close();
  }
});

test("an unknown /api/ path returns a JSON 404 rather than falling through to static-file handling", async () => {
  const { base, close } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/this-route-does-not-exist`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type")?.split(";")[0], "application/json");
  } finally {
    await close();
  }
});

test("closing an SSE client connection removes it from the server's tracked client set instead of leaking it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-sse-"));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  try {
    const sessionId = await runOneChat(base, dir, "sse cleanup task");

    const controller = new AbortController();
    const streamRes = await fetch(`${base}/api/sessions/${sessionId}/events`, { signal: controller.signal });
    assert.equal(streamRes.status, 200);
    // Make sure the connection is actually established and registered before tearing it down.
    const reader = streamRes.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});

    // Give the server's `request.on("close", ...)` handler a moment to run, then confirm a fresh
    // client on the same session still gets served correctly — i.e. the map wasn't left in a broken
    // state by the aborted connection.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const controller2 = new AbortController();
    const streamRes2 = await fetch(`${base}/api/sessions/${sessionId}/events`, { signal: controller2.signal });
    assert.equal(streamRes2.status, 200);
    controller2.abort();
  } finally {
    await close();
  }
});

test("graceful shutdown ends all open SSE streams, closes the registry, and stops accepting new connections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-shutdown-"));
  await initRepo(dir);
  const { base, server } = await startTestServer();
  const sessionId = await runOneChat(base, dir, "shutdown task");

  const controller = new AbortController();
  const streamRes = await fetch(`${base}/api/sessions/${sessionId}/events`, { signal: controller.signal });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body!.getReader();
  await reader.read();

  const streamEnded = reader.read().then(
    (r) => r.done,
    () => true,
  );

  const { shutdownWebServer } = await import("../../dist/http/server.js");
  await shutdownWebServer(server, 1000);

  assert.equal(await streamEnded, true, "the SSE stream must be ended by shutdown, not left hanging");

  await assert.rejects(
    fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(2000) }),
    "a shut-down server must refuse new connections",
  );
});

test("graceful shutdown aborts an in-flight run instead of leaving it orphaned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-shutdown-abort-"));
  await initRepo(dir);
  const { base, server } = await startTestServer();

  const chatRes = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "shutdown-abort task", cwd: dir }),
  });
  assert.equal(chatRes.status, 202);
  const { sessionId } = (await chatRes.json()) as { sessionId: string };

  const { shutdownWebServer } = await import("../../dist/http/server.js");
  await shutdownWebServer(server, 1000);

  const registry = new SessionRegistry(registryPath);
  try {
    const entry = registry.get(sessionId);
    assert.ok(entry, "the session must still be registered/discoverable after shutdown");
  } finally {
    registry.close();
  }
});

test("restart recovery: a session left mid-phase by a killed process (no lock, no terminal event) is reported as orphaned, not silently 'in progress'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-orphan-"));
  const dbPath = join(dir, "events.db");
  const sessionId = "orphan-session-1";

  const store = new EventStore(dbPath);
  try {
    store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "orphaned task", budgetCeilingUsd: 5, minQuorum: 1 } });
    // No WorktreeCreated/PhaseExited/SessionCancelled/SessionErrored — this mirrors exactly what a
    // hard-killed process leaves behind: an open phase and no lock, since the lock file (a separate,
    // ordinary file on disk) dies with the process that held it instead of being durably recorded.
    store.append(sessionId, { type: "PhaseEntered", payload: { phase: "PLAN", round: 0 } });
  } finally {
    store.close();
  }

  const registry = new SessionRegistry(registryPath);
  try {
    registry.register(sessionId, dbPath, dir);
  } finally {
    registry.close();
  }

  const { base, close } = await startTestServer();
  try {
    const statusRes = await fetch(`${base}/api/sessions/${sessionId}`);
    assert.equal(statusRes.status, 200);
    const { session } = (await statusRes.json()) as { session: { phaseOpen: boolean; orphaned: boolean } };
    assert.equal(session.phaseOpen, true);
    assert.equal(session.orphaned, true);

    const listRes = await fetch(`${base}/api/sessions`);
    assert.equal(listRes.status, 200);
    const { sessions } = (await listRes.json()) as { sessions: Array<{ sessionId: string; orphaned: boolean }> };
    const listed = sessions.find((s) => s.sessionId === sessionId);
    assert.ok(listed, "orphaned session must still appear in the session list");
    assert.equal(listed.orphaned, true);
  } finally {
    await close();
  }
});

test("session detail is a sanitized view: no absolute paths or raw projection, but state, branch, and deliberation", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "conclave-http-detail-")));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  try {
    const sessionId = await runOneChat(base, dir, "detail please");
    const res = await fetch(`${base}/api/sessions/${sessionId}`);
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes(dir), "the repository path must never reach the browser");
    assert.ok(!raw.includes(`/tmp/conclave-${sessionId}`), "nor the worktree or artifact paths");
    const { session } = JSON.parse(raw) as { session: Record<string, unknown> & { deliberation: { findings: unknown }; seats: unknown[] } };
    assert.equal(session.state, "approved");
    assert.equal(session.outcome, "APPROVED");
    assert.equal(session.branch, `conclave/${sessionId}`);
    assert.equal(session.worktreeState, "removed");
    assert.ok(session.deliberation.findings);
    assert.equal(session.seats.length, 3);
    for (const key of ["repoPath", "worktree", "seatInvocations"]) assert.equal(key in session, false, `${key} must not be exposed`);
  } finally {
    await close();
  }
});

async function seedEscalatedSession(sessionId: string): Promise<{ dbPath: string; contentionId: string }> {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-ruling-"));
  const dbPath = join(dir, "events.db");
  const contentionId = "c-authz";
  const store = new EventStore(dbPath);
  try {
    store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "add login", budgetCeilingUsd: 5, minQuorum: 2 } });
    store.append(sessionId, { type: "ContentionOpened", payload: { contentionId, targets: ["src/auth.ts"], category: "authz", severity: "BLOCKER", findingIds: ["f-auth"] } });
    store.append(sessionId, { type: "ArbitrationRuled", payload: { contentionId, arbiters: ["claude"], ruling: "DEFERRED", reasoning: "inconclusive on a BLOCKER", source: "policy" } });
    store.append(sessionId, { type: "ContentionResolved", payload: { contentionId, terminalState: "HUMAN_ARBITRATION" } });
    store.append(sessionId, { type: "SessionConcluded", payload: { outcome: "AWAITING_HUMAN", reason: "contentions unresolved" } });
  } finally {
    store.close();
  }
  const registry = new SessionRegistry(registryPath);
  try {
    registry.register(sessionId, dbPath, dir);
  } finally {
    registry.close();
  }
  return { dbPath, contentionId };
}

test("a human ruling posted through the API settles an escalated contention exactly once", async () => {
  const sessionId = "ruling-session-1";
  const { contentionId } = await seedEscalatedSession(sessionId);
  const { base, close } = await startTestServer();
  const post = (body: unknown, id = contentionId) =>
    fetch(`${base}/api/sessions/${sessionId}/contentions/${id}/ruling`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const listed = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ sessionId: string; state: string; awaitingHumanRuling: number }> };
    const entry = listed.sessions.find((s) => s.sessionId === sessionId);
    assert.equal(entry?.state, "awaiting_human");
    assert.equal(entry?.awaitingHumanRuling, 1);

    assert.equal((await post({ ruling: "MAYBE", reasoning: "x" })).status, 400);
    assert.equal((await post({ ruling: "DISMISSED", reasoning: "   " })).status, 400);
    assert.equal((await post({ ruling: "DISMISSED", reasoning: "x" }, "c-unknown")).status, 409);

    const ok = await post({ ruling: "DISMISSED", reasoning: "handled by the gateway" });
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { awaitingHumanRuling: string[] }).awaitingHumanRuling, []);
    assert.equal((await post({ ruling: "UPHELD", reasoning: "again" })).status, 409, "a settled contention cannot be re-ruled");

    const { session } = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as {
      session: { contentions: Array<{ contentionId: string; status: string; ruling?: { source: string; ruling: string } }>; awaitingHumanRuling: string[] };
    };
    const contention = session.contentions.find((c) => c.contentionId === contentionId);
    assert.equal(contention?.status, "WITHDRAWN");
    assert.equal(contention?.ruling?.source, "human");
    assert.deepEqual(session.awaitingHumanRuling, []);
  } finally {
    await close();
  }
});

test("per-session cancel: 404 for an unknown session, 409 for one no process is running", async () => {
  await seedEscalatedSession("cancel-idle-session");
  const { base, close } = await startTestServer();
  try {
    assert.equal((await fetch(`${base}/api/sessions/nope/cancel`, { method: "POST" })).status, 404);
    const idle = await fetch(`${base}/api/sessions/cancel-idle-session/cancel`, { method: "POST" });
    assert.equal(idle.status, 409);
    assert.match(((await idle.json()) as { error: string }).error, /not running/);
  } finally {
    await close();
  }
});

test("seat health never spends on a page load: CLI seats are probed (a billed call) only on an explicit refresh, then cached", async () => {
  const { base, close } = await startTestServer();
  try {
    const first = (await (await fetch(`${base}/api/auth/status`)).json()) as { checkedAt: string | null; seats: Array<{ unchecked?: boolean }> };
    assert.equal(first.seats.length, 3);
    assert.equal(first.checkedAt, null, "nothing was probed");
    assert.ok(first.seats.every((seat) => seat.unchecked), "CLI seats are reported unchecked rather than probed");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const refreshed = (await (await fetch(`${base}/api/auth/status`, { method: "POST" })).json()) as { checkedAt: string; seats: Array<{ unchecked?: boolean }> };
    const viaQuery = (await (await fetch(`${base}/api/auth/status?refresh=1`)).json()) as { checkedAt: string };
    assert.equal(viaQuery.checkedAt, refreshed.checkedAt, "a GET never re-probes, whatever its query says");
    assert.ok(refreshed.checkedAt);
    assert.ok(refreshed.seats.every((seat) => !seat.unchecked));
    const again = (await (await fetch(`${base}/api/auth/status`)).json()) as { checkedAt: string };
    assert.equal(again.checkedAt, refreshed.checkedAt, "a plain request reuses the last probe instead of re-running it");
  } finally {
    await close();
  }
});

async function seedSession(sessionId: string, fill: (store: EventStore) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "conclave-http-seed-"));
  const dbPath = join(dir, "events.db");
  const store = new EventStore(dbPath);
  try {
    store.append(sessionId, { type: "SessionCreated", payload: { sessionId, task: "seeded", budgetCeilingUsd: 5, minQuorum: 1 } });
    fill(store);
  } finally {
    store.close();
  }
  const registry = new SessionRegistry(registryPath);
  try {
    registry.register(sessionId, dbPath, dir);
  } finally {
    registry.close();
  }
  return dbPath;
}

test("message pages count messages, not scanned events: a long run of non-chat events never yields an empty page mid-stream", async () => {
  const sessionId = "paging-session-1";
  await seedSession(sessionId, (store) => {
    store.append(sessionId, { type: "UserMessagePosted", payload: { text: "first" } });
    for (let i = 0; i < 300; i++) {
      store.append(sessionId, { type: "BudgetSpent", payload: { correlationId: `c${i}`, phase: "PLAN_AUDIT", round: 0, usageAvailable: false, costSource: "unavailable", latencyMs: 1 } });
    }
    store.append(sessionId, { type: "ActivityLogged", payload: { kind: "system", message: "second" } });
  });
  const { base, close } = await startTestServer();
  try {
    const page1 = (await (await fetch(`${base}/api/sessions/${sessionId}/messages?limit=1`)).json()) as { messages: Array<{ seq: number; text: string }> };
    assert.deepEqual(page1.messages.map((m) => m.text), ["first"]);
    const page2 = (await (await fetch(`${base}/api/sessions/${sessionId}/messages?limit=200&after=${page1.messages[0]!.seq}`)).json()) as { messages: Array<{ text: string }> };
    assert.deepEqual(page2.messages.map((m) => m.text), ["second"], "300 intervening non-chat events must not produce an empty page");

    const noMessage = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "  " }) });
    assert.equal(noMessage.status, 400);
    assert.match(((await noMessage.json()) as { error: string }).error, /message is required/);
  } finally {
    await close();
  }
});

test("a session advanced by another process (e.g. a terminal `conclave run`) still streams live to a watching browser", async () => {
  const sessionId = "tail-session-1";
  const dbPath = await seedSession(sessionId, (store) => {
    store.append(sessionId, { type: "ActivityLogged", payload: { kind: "system", message: "before" } });
  });
  const { base, close } = await startTestServer();
  try {
    const response = await openSse(`${base}/api/sessions/${sessionId}/events`);
    const framesPromise = readSseFrames(response, { count: 2, timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Written straight to the log, the way a separate process would — this server never sees it happen.
    const store = new EventStore(dbPath);
    try {
      store.append(sessionId, { type: "ActivityLogged", payload: { kind: "system", message: "from another process" } });
    } finally {
      store.close();
    }
    const frames = await framesPromise;
    assert.deepEqual(frames.map((frame) => (frame.data as { text: string }).text), ["before", "from another process"]);
  } finally {
    await close();
  }
});

test("spend meters and limits are account-wide: usage is summed across every registered repository", async () => {
  const spend = (store: EventStore, sessionId: string, costUsd: number) =>
    store.append(sessionId, { type: "BudgetSpent", payload: { correlationId: `c-${costUsd}`, seat: "claude", phase: "PLAN", round: 0, usageAvailable: true, promptTokens: 10, completionTokens: 5, costUsd, costSource: "local_estimate", latencyMs: 1 } });
  await seedSession("usage-repo-a", (store) => spend(store, "usage-repo-a", 1.25));
  await seedSession("usage-repo-b", (store) => spend(store, "usage-repo-b", 2.5));
  const { base, close } = await startTestServer();
  try {
    const usage = (await (await fetch(`${base}/api/usage`)).json()) as { fiveHour: { totalUsd: number }; weekly: { totalUsd: number } };
    assert.ok(usage.fiveHour.totalUsd >= 3.75 - 1e-9, `expected both repositories' spend to be counted, got ${usage.fiveHour.totalUsd}`);
    assert.ok(usage.weekly.totalUsd >= 3.75 - 1e-9);
  } finally {
    await close();
  }
});

test("session detail says what each seat actually did, and offers resume exactly when the server would accept it", async () => {
  const sessionId = "seat-outcomes-1";
  await seedSession(sessionId, (store) => {
    const seat = (id: string) => ({ id, label: id, adapter: "cli" as const, cliCommand: id, role: "CORRECTNESS" as const, temperature: 0.2, maxTokens: 100, timeoutMs: 1000, enabled: true, tier: "standard" as const });
    store.append(sessionId, { type: "SessionConfigured", payload: { configVersion: 1, repoPath: "/somewhere/demo-repo", seats: [seat("claude"), seat("codex")], discussionRoundCap: 6, remediationRoundCap: 3, budgetCeilingUsd: 5, allowDirtySource: false } });
    store.append(sessionId, { type: "WorktreeCreated", payload: { baseCommit: "abc", branch: `conclave/${sessionId}`, path: "/tmp/conclave-nowhere" } });
    store.append(sessionId, { type: "PhaseEntered", payload: { phase: "RATIFY_WORK", round: 0 } });
    const verdict = { seat: "codex", findings: [], overall_verdict: "APPROVE" as const, verdict_reasoning: "ok" };
    store.append(sessionId, { type: "SeatInvoked", payload: { correlationId: "a", seat: "codex", phase: "RATIFY_WORK", round: 0, verdict, status: "OK" } });
    store.append(sessionId, { type: "SeatInvoked", payload: { correlationId: "b", seat: "claude", phase: "RATIFY_WORK", round: 0, status: "UNAVAILABLE" } });
    store.append(sessionId, { type: "BudgetSpent", payload: { correlationId: "a", seat: "codex", phase: "RATIFY_WORK", round: 0, usageAvailable: true, promptTokens: 1, completionTokens: 1, costUsd: 0.4, costSource: "local_estimate", latencyMs: 1 } });
    store.append(sessionId, { type: "SessionCancelled", payload: { reason: "stopped" } });
  });
  const { base, close } = await startTestServer();
  try {
    const { session } = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as {
      session: { repo: string; resumable: boolean; resumeFrom?: { phase: string }; budgetRemainingUsd: number; startedAt: string; seats: Array<{ id: string; spentUsd: number; failures: Array<{ phase: string; status: string }>; verdicts: Array<{ verdict: string }> }> };
    };
    const codex = session.seats.find((s) => s.id === "codex")!;
    const claude = session.seats.find((s) => s.id === "claude")!;
    assert.equal(codex.spentUsd, 0.4);
    assert.deepEqual(codex.verdicts.map((v) => v.verdict), ["APPROVE"]);
    assert.deepEqual(claude.failures, [{ phase: "RATIFY_WORK", round: 0, status: "UNAVAILABLE" }]);
    assert.equal(session.resumable, true);
    const listed = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ sessionId: string; resumable: boolean }> };
    assert.equal(listed.sessions.find((s) => s.sessionId === sessionId)?.resumable, true, "the list says resumable too, by the same rule");
    assert.equal(session.resumeFrom?.phase, "WORK_AUDIT", "an interrupted work vote re-verifies from a fresh audit");
    assert.equal(session.budgetRemainingUsd, 4.6);
    assert.ok(session.startedAt);
    assert.equal(typeof session.repo, "string");

    // Once the worktree is pruned, resume is no longer offered.
    const dbPath = (() => { const r = new SessionRegistry(registryPath); try { return r.get(sessionId)!.dbPath; } finally { r.close(); } })();
    const store = new EventStore(dbPath);
    store.append(sessionId, { type: "WorktreeRemoved", payload: { reason: "pruned: no activity for over 14 day(s)" } });
    store.close();
    const after = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session: { resumable: boolean; worktreeRemovedReason?: string } };
    assert.equal(after.session.resumable, false);
    assert.match(after.session.worktreeRemovedReason ?? "", /pruned/);
  } finally {
    await close();
  }
});

test("model switching over HTTP: a seat's catalog, a per-council override recorded with the session, and rejected overrides", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "conclave-http-models-")));
  await initRepo(dir);
  const { base, close } = await startTestServer();
  try {
    const catalog = (await (await fetch(`${base}/api/seats/claude/models`)).json()) as { models: Array<{ id: string }>; authoritative: boolean };
    assert.ok(catalog.models.some((m) => m.id === "claude-sonnet-5"));
    assert.equal(catalog.authoritative, false);
    assert.equal((await fetch(`${base}/api/seats/nosuch/models`)).status, 404);

    const bad = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "t", cwd: dir, models: { nosuch: "x" } }) });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /no seat named nosuch/);

    const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "use another model", cwd: dir, models: { codex: "gpt-override-1" } }) });
    assert.equal(res.status, 202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    let seats: Array<{ id: string; configuredModel?: string }> = [];
    for (let i = 0; i < 100; i++) {
      const detail = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session?: { state: string; seats: typeof seats } };
      if (detail.session?.seats?.length) seats = detail.session.seats;
      if (detail.session && !["running", "orphaned"].includes(detail.session.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(seats.find((s) => s.id === "codex")?.configuredModel, "gpt-override-1", "the override is part of the session's recorded configuration");
    assert.equal(seats.find((s) => s.id === "claude")?.configuredModel, undefined, "other seats are untouched");

    const probe = await fetch(`${base}/api/seats/claude/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-opus-5-5" }) });
    assert.equal(probe.status, 200);
    const result = (await probe.json()) as { healthy: boolean; model?: string };
    assert.equal(typeof result.healthy, "boolean");
    assert.equal(result.model, "claude-opus-5-5");
  } finally {
    await close();
  }
});

/** node:http directly, so the Host and Origin headers can be set the way a hostile page would. */
function rawRequest(base: string, path: string, headers: Record<string, string>, method = "GET", payload?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const { port } = new URL(base);
    import("node:http").then(({ request }) => {
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    }, reject);
  });
}

test("requests from other websites are refused: a foreign Origin (CSRF) or a foreign Host (DNS rebinding)", async () => {
  const { base, close } = await startTestServer();
  const port = new URL(base).port;
  try {
    const csrf = await rawRequest(base, "/api/chat", { "content-type": "text/plain", origin: "https://evil.example" }, "POST", JSON.stringify({ message: "spend money", cwd: "/tmp" }));
    assert.equal(csrf.status, 403, "a cross-site POST must never start a council");
    assert.equal((await rawRequest(base, "/api/seats", { host: `evil.example:${port}` })).status, 403);
    assert.equal((await rawRequest(base, "/api/fs/dirs", { origin: "null" })).status, 403);
    assert.equal((await rawRequest(base, "/api/seats", { origin: `http://localhost:${port}`, host: `localhost:${port}` })).status, 200, "Conclave's own page is allowed");
    assert.equal((await rawRequest(base, "/api/seats", {})).status, 200, "non-browser clients without an Origin are allowed");
  } finally {
    await close();
  }
});

test("choosing a repository: browse folders, inspect one, and get refused early for folders a council cannot run in", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "conclave-http-fs-")));
  const repo = join(root, "repo-a");
  await (await import("node:fs/promises")).mkdir(join(repo, "sub"), { recursive: true });
  await (await import("node:fs/promises")).mkdir(join(root, "plain"));
  await (await import("node:fs/promises")).mkdir(join(root, ".hidden"));
  await initRepo(repo);
  const { base, close } = await startTestServer();
  const getJson = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<Record<string, unknown>>;
  try {
    const listing = (await getJson(`/api/fs/dirs?path=${encodeURIComponent(root)}`)) as { path: string; entries: Array<{ name: string; isGitRepo: boolean }>; parent: string };
    assert.equal(listing.path, root);
    assert.deepEqual(listing.entries.map((e) => [e.name, e.isGitRepo]), [["plain", false], ["repo-a", true]], "hidden folders are left out");
    assert.equal(listing.parent, dirname(root));
    assert.equal((await fetch(`${base}/api/fs/dirs?path=${encodeURIComponent(join(root, "nope"))}`)).status, 404);
    assert.equal(((await getJson(`/api/fs/dirs?path=~`)) as { path: string }).path, await realpath(homedir()), "~ means the home directory");

    const clean = (await getJson(`/api/fs/repo?path=${encodeURIComponent(join(repo, "sub"))}`)) as { isGitRepo: boolean; root: string; changes: number };
    assert.equal(clean.isGitRepo, true);
    assert.equal(clean.root, repo, "a subfolder resolves to its repository");
    assert.equal(clean.changes, 0);
    const plain = (await getJson(`/api/fs/repo?path=${encodeURIComponent(join(root, "plain"))}`)) as { isGitRepo: boolean; kind: string };
    assert.equal(plain.isGitRepo, false);
    assert.equal(plain.kind, "folder", "a plain folder is usable: it runs on a private snapshot");
    assert.equal(((await getJson(`/api/fs/repo?path=${encodeURIComponent(repo)}`)) as { kind: string }).kind, "git");

    const chat = (body: Record<string, unknown>) => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "t", ...body }) });
    const waitFor = async (sessionId: string) => {
      for (let i = 0; i < 150; i++) {
        const detail = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session?: { state: string } };
        if (detail.session && !["running", "orphaned"].includes(detail.session.state)) return detail.session;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("council did not finish");
    };
    await writeFile(join(root, "plain", "notes.md"), "plain folder\n");
    const plainRun = await chat({ cwd: join(root, "plain") });
    assert.equal(plainRun.status, 202, "a folder that is not a git repository is accepted");
    const plainSession = (await waitFor(((await plainRun.json()) as { sessionId: string }).sessionId)) as { state: string; workspace?: string; applicable?: boolean };
    assert.equal(plainSession.workspace, "snapshot");
    await assert.rejects(() => stat(join(root, "plain", ".git")), "the folder never gets a .git");

    await writeFile(join(repo, "dirty.txt"), "uncommitted\n");
    const dirty = (await getJson(`/api/fs/repo?path=${encodeURIComponent(repo)}`)) as { changes: number };
    assert.equal(dirty.changes, 1);
    const refused = await chat({ cwd: repo });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /uncommitted changes \(1 file\)/);
    const allowed = await chat({ cwd: join(repo, "sub"), allowDirtySource: true });
    assert.equal(allowed.status, 202, "opting in to uncommitted changes starts the council");
    const { sessionId } = (await allowed.json()) as { sessionId: string };
    for (let i = 0; i < 100; i++) {
      const detail = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session?: { state: string } };
      if (detail.session && !["running", "orphaned"].includes(detail.session.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const recent = (await getJson("/api/repos/recent")) as { repos: Array<{ path: string }> };
    assert.ok(recent.repos.some((r) => r.path === repo), "the council ran at the repository root, which is now a recent repository");
  } finally {
    await close();
  }
});

test("POST /api/sessions/:id/apply writes a ratified plain-folder session into the folder once; other sessions are refused", async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "conclave-http-apply-")));
  await writeFile(join(folder, "a.txt"), "a\n");
  const { base, close } = await startTestServer();
  try {
    const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "noop", cwd: folder }) });
    assert.equal(res.status, 202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    let session: { state?: string; applicable?: boolean } = {};
    for (let i = 0; i < 150; i++) {
      session = ((await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session: typeof session }).session;
      if (session.state && !["running", "orphaned"].includes(session.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(session.state, "approved");
    assert.equal(session.applicable, true, "a ratified snapshot session offers Apply");
    const apply = (check: boolean) => fetch(`${base}/api/sessions/${sessionId}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ check }) });
    const checked = (await (await apply(true)).json()) as { applied: boolean; files: unknown[] };
    assert.equal(checked.applied, false);
    assert.equal((await apply(false)).status, 200);
    const again = await apply(false);
    assert.equal(again.status, 400);
    assert.match(((await again.json()) as { error: string }).error, /already applied/);
    const after = ((await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session: { applicable: boolean; applied?: unknown } }).session;
    assert.equal(after.applicable, false);
    assert.ok(after.applied);
    assert.equal((await fetch(`${base}/api/sessions/nope/apply`, { method: "POST" })).status, 404);
  } finally {
    await close();
  }
});


test("two convenes arriving together start one council; the other is refused", async () => {
  const { base, close } = await startTestServer();
  const dir = await realpath(await mkdtemp(join(tmpdir(), "conclave-http-race-")));
  await initRepo(dir);
  try {
    const convene = () => fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "race", cwd: dir }) });
    const statuses = (await Promise.all([convene(), convene()])).map((response) => response.status).sort();
    assert.deepEqual(statuses, [202, 409]);
  } finally {
    await waitForIdle(base);
    await close();
  }
});

test("a JSON body that is not an object is a 400, not a 500", async () => {
  const { base, close } = await startTestServer();
  try {
    for (const route of ["/api/chat", "/api/seats"]) {
      const response = await fetch(`${base}${route}`, { method: route === "/api/seats" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: "null" });
      assert.equal(response.status, 400, route);
    }
    const typed = await fetch(`${base}/api/seats`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "codex", cliModel: { x: 1 } }) });
    assert.equal(typed.status, 400, "a model that is not a string is never saved");
  } finally {
    await close();
  }
});

test("a request a browser marks as coming from another site is refused, even a no-cors GET with no Origin", async () => {
  const { base, close } = await startTestServer();
  try {
    const crossSite = await fetch(`${base}/api/auth/status`, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } });
    assert.equal(crossSite.status, 403);
    const otherPort = await fetch(`${base}/api/sessions`, { headers: { "sec-fetch-site": "same-site" } });
    assert.equal(otherPort.status, 403, "another port on localhost is the same site, but not this page");
    const own = await fetch(`${base}/api/sessions`, { headers: { "sec-fetch-site": "same-origin" } });
    assert.equal(own.status, 200);
  } finally {
    await close();
  }
});

test("a task whose multi-byte characters straddle two network chunks arrives intact", async () => {
  const { base, close } = await startTestServer();
  const dir = await realpath(await mkdtemp(join(tmpdir(), "conclave-http-utf8-")));
  await initRepo(dir);
  try {
    const { request } = await import("node:http");
    const payload = Buffer.from(JSON.stringify({ message: "modèle-é", cwd: dir }), "utf8");
    const split = payload.indexOf(Buffer.from("è")) + 1; // inside the two-byte "è"
    const sessionId = await new Promise<string>((resolve, reject) => {
      const req = request(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve((JSON.parse(text) as { sessionId: string }).sessionId));
      });
      req.on("error", reject);
      req.write(payload.subarray(0, split));
      setTimeout(() => req.end(payload.subarray(split)), 20);
    });
    await waitForIdle(base);
    const { session } = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session: { task: string } };
    assert.equal(session.task, "modèle-é");
  } finally {
    await close();
  }
});

test("a council that fails before it starts (an unusable seat config) is recorded as failed, and the server keeps running", async () => {
  const configPath = process.env.CONCLAVE_SEAT_CONFIG_PATH!;
  const original = new SeatConfigStore(configPath).get();
  const { base, close } = await startTestServer();
  const dir = await realpath(await mkdtemp(join(tmpdir(), "conclave-http-nostart-")));
  await initRepo(dir);
  try {
    // Hand-edited: claude disabled. Valid per schema; refused by the council itself.
    await writeFile(configPath, JSON.stringify({ version: original.version + 1, seats: original.seats.map((s) => (s.id === "claude" ? { ...s, enabled: false } : s)) }));
    const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "t", cwd: dir }) });
    assert.equal(response.status, 202);
    const { sessionId } = (await response.json()) as { sessionId: string };
    await waitForIdle(base);
    const { session } = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as { session: { state: string } };
    assert.equal(session.state, "errored", "recorded, not left looking orphaned");
    assert.equal((await fetch(`${base}/api/sessions`)).status, 200, "the server is still up");
  } finally {
    const restored = new SeatConfigStore(configPath);
    restored.save(original.seats, { replaceInvalid: true });
    await close();
  }
});

/** Waits until this server reports no council running (it runs one at a time). */
async function waitForIdle(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { sessions } = (await (await fetch(`${base}/api/sessions`)).json()) as { sessions: Array<{ state: string }> };
    if (!sessions.some((session) => session.state === "running")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("a council was still running");
}
