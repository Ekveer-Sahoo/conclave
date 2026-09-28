import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CLI_SEATS } from "@conclave/core";
import { SeatConfigStore } from "../../src/http/seatConfigStore.ts";

const configPath = () => join(mkdtempSync(join(tmpdir(), "conclave-seatcfg-")), "seat-config.json");

test("a missing config file is not a problem: the default seats are used silently", () => {
  const store = new SeatConfigStore(configPath());
  assert.deepEqual(store.get().seats.map((seat) => seat.id), DEFAULT_CLI_SEATS.map((seat) => seat.id));
  assert.equal(store.problem(), undefined);
});

test("an invalid seat (unknown adapter) is rejected at load time and reported, instead of crashing a run later", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ version: 3, seats: [{ id: "claude", label: "Claude", adapter: "telepathy", role: "ARCHITECTURE" }] }));
  const store = new SeatConfigStore(path);
  assert.deepEqual(store.get().seats.map((seat) => seat.id), DEFAULT_CLI_SEATS.map((seat) => seat.id));
  assert.match(store.problem() ?? "", /invalid and was ignored/);
  assert.match(store.problem() ?? "", /adapter/);
});

test("a valid config is loaded with schema defaults filled in, and saving clears any earlier problem", () => {
  const path = configPath();
  writeFileSync(path, "{not json");
  const store = new SeatConfigStore(path);
  assert.ok(store.problem());
  store.save([{ ...DEFAULT_CLI_SEATS[0]! }]);
  assert.equal(store.problem(), undefined);

  writeFileSync(path, JSON.stringify({ version: 7, seats: [{ id: "reviewer", label: "Reviewer", adapter: "xenia", xeniaModel: "cc/claude-haiku-4-5-20251001", role: "SECURITY" }] }));
  const reloaded = new SeatConfigStore(path);
  assert.equal(reloaded.problem(), undefined);
  assert.equal(reloaded.get().version, 7);
  assert.equal(reloaded.get().seats[0]!.timeoutMs, 60_000, "schema defaults are applied");
  assert.equal(reloaded.get().seats[0]!.enabled, true);
});
