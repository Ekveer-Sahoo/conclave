import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionRegistry } from "../../src/store/sessionRegistry.ts";

function tmpRegistryPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "conclave-registry-")), "registry.db");
}

test("recovers from a corrupt registry file instead of crashing, and quarantines the bad file", () => {
  const registryPath = tmpRegistryPath();
  fs.writeFileSync(registryPath, "this is not a sqlite file, just garbage bytes");

  const registry = new SessionRegistry(registryPath);
  try {
    const entry = registry.register("s1", "/tmp/s1/events.db", "/tmp/s1");
    assert.equal(entry.sessionId, "s1");
    assert.equal(registry.get("s1")?.dbPath, "/tmp/s1/events.db");
  } finally {
    registry.close();
  }

  const dir = path.dirname(registryPath);
  const quarantined = fs.readdirSync(dir).filter((f) => f.startsWith("registry.db.corrupt-"));
  assert.equal(quarantined.length, 1, "the corrupt original must be preserved under a quarantine name");
  assert.equal(
    fs.readFileSync(path.join(dir, quarantined[0]!), "utf8"),
    "this is not a sqlite file, just garbage bytes",
  );
});

test("recovers from a registry file that opens but fails integrity_check", () => {
  const registryPath = tmpRegistryPath();
  // A zero-length file opens fine as an empty SQLite database (valid header, no schema) — not the
  // corruption case we're targeting here. Truncate a real, non-empty file that will fail on its
  // very first page read instead: write a plausible SQLite header followed by garbage.
  const header = Buffer.from("SQLite format 3\0", "utf8");
  const junk = Buffer.alloc(4096, 0xff);
  fs.writeFileSync(registryPath, Buffer.concat([header, junk]));

  const registry = new SessionRegistry(registryPath);
  try {
    const entry = registry.register("s1", "/tmp/s1/events.db", "/tmp/s1");
    assert.equal(entry.sessionId, "s1");
  } finally {
    registry.close();
  }
});

test("a missing registry file is not treated as corruption — it just creates a fresh database", () => {
  const registryPath = tmpRegistryPath();
  assert.ok(!fs.existsSync(registryPath));
  const registry = new SessionRegistry(registryPath);
  try {
    registry.register("s1", "/tmp/s1/events.db", "/tmp/s1");
    assert.ok(registry.get("s1"));
  } finally {
    registry.close();
  }
  const dir = path.dirname(registryPath);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 0);
});

test("list() clamps pagination edge cases instead of erroring or returning garbage", () => {
  const registryPath = tmpRegistryPath();
  const registry = new SessionRegistry(registryPath);
  try {
    for (let i = 0; i < 5; i++) {
      registry.register(`s${i}`, `/tmp/s${i}/events.db`, `/tmp/s${i}`);
    }

    assert.deepEqual(registry.list(0, 0), [], "limit=0 returns no rows");
    assert.equal(registry.list(1000, 0).length, 5, "an oversized limit just returns everything available");
    assert.deepEqual(registry.list(10, 999), [], "an offset past the end returns no rows, not an error");
    assert.deepEqual(registry.list(-5, 0), [], "a negative limit is clamped to zero rows, not treated as unlimited");
    assert.equal(registry.list(10, -3).length, 5, "a negative offset is clamped to zero rather than throwing");
  } finally {
    registry.close();
  }
});

test("list() orders most-recently-updated first and pages consistently across boundary offsets", () => {
  const registryPath = tmpRegistryPath();
  const registry = new SessionRegistry(registryPath);
  try {
    for (let i = 0; i < 7; i++) {
      registry.register(`s${i}`, `/tmp/s${i}/events.db`, `/tmp/s${i}`);
    }
    // Force distinct, known updated_at ordering by touching in reverse.
    for (let i = 6; i >= 0; i--) registry.touch(`s${i}`);

    const page1 = registry.list(3, 0);
    const page2 = registry.list(3, 3);
    const page3 = registry.list(3, 6);
    const all = [...page1, ...page2, ...page3];

    assert.equal(page1.length, 3);
    assert.equal(page2.length, 3);
    assert.equal(page3.length, 1);
    assert.deepEqual(
      all.map((e) => e.sessionId),
      ["s0", "s1", "s2", "s3", "s4", "s5", "s6"],
      "consecutive pages must exactly tile the full, stably-ordered result set with no gaps or repeats",
    );
  } finally {
    registry.close();
  }
});

test("concurrent registration of distinct sessions from two independent registry instances is not corrupted", () => {
  const registryPath = tmpRegistryPath();
  const a = new SessionRegistry(registryPath);
  const b = new SessionRegistry(registryPath);
  try {
    for (let i = 0; i < 20; i++) {
      const registry = i % 2 === 0 ? a : b;
      registry.register(`s${i}`, `/tmp/s${i}/events.db`, `/tmp/s${i}`);
    }

    // Both handles share the same on-disk WAL-mode file, so either one must see every row.
    assert.equal(a.list(100, 0).length, 20);
    assert.equal(b.list(100, 0).length, 20);
    for (let i = 0; i < 20; i++) {
      assert.equal(a.get(`s${i}`)?.dbPath, `/tmp/s${i}/events.db`);
    }
  } finally {
    a.close();
    b.close();
  }
});

test("concurrent re-registration of the same sessionId from two instances converges to one consistent row, not a duplicate or split state", () => {
  const registryPath = tmpRegistryPath();
  const a = new SessionRegistry(registryPath);
  const b = new SessionRegistry(registryPath);
  try {
    a.register("shared", "/tmp/shared/events-a.db", "/tmp/shared-a");
    b.register("shared", "/tmp/shared/events-b.db", "/tmp/shared-b");

    const fromA = a.get("shared");
    const fromB = b.get("shared");
    assert.deepEqual(fromA, fromB, "both instances must observe the same converged row after a WAL-mode write from either");
    assert.equal(fromA?.dbPath, "/tmp/shared/events-b.db", "the later write (from b) must win, not a merge of fields from both");
    assert.equal(a.list(100, 0).filter((e) => e.sessionId === "shared").length, 1, "no duplicate row was created");
  } finally {
    a.close();
    b.close();
  }
});

test("register() is atomic: a re-registration updates dbPath and updated_at together, never one without the other", () => {
  const registryPath = tmpRegistryPath();
  const registry = new SessionRegistry(registryPath);
  try {
    const first = registry.register("s1", "/tmp/s1/events-v1.db", "/tmp/s1");
    const second = registry.register("s1", "/tmp/s1/events-v2.db", "/tmp/s1");

    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.createdAt, first.createdAt, "created_at must never change on re-registration");
    assert.equal(second.dbPath, "/tmp/s1/events-v2.db", "db_path must reflect the new value");
    assert.notEqual(second.dbPath, first.dbPath, "sanity check that this test actually changed dbPath");
    assert.ok(
      new Date(second.updatedAt).getTime() >= new Date(first.updatedAt).getTime(),
      "updated_at must advance together with db_path in the same write, not lag behind it",
    );

    const reread = registry.get("s1");
    assert.deepEqual(reread, second, "a fresh read must match what register() returned — no partially-applied write");
  } finally {
    registry.close();
  }
});

test("touch() only ever changes updated_at, leaving every other field untouched", () => {
  const registryPath = tmpRegistryPath();
  const registry = new SessionRegistry(registryPath);
  try {
    const before = registry.register("s1", "/tmp/s1/events.db", "/tmp/s1");
    registry.touch("s1");
    const after = registry.get("s1")!;

    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.dbPath, before.dbPath);
    assert.equal(after.repoPathRedacted, before.repoPathRedacted);
    assert.equal(after.createdAt, before.createdAt);
    assert.ok(new Date(after.updatedAt).getTime() >= new Date(before.updatedAt).getTime());
  } finally {
    registry.close();
  }
});
