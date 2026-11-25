import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SeatConfig } from "@conclave/core";
import { applyModelOverrides, modelCatalog, parseModelOverrides } from "../../dist/seats/modelCatalog.js";

const seat = (id: string, extra: Partial<SeatConfig> = {}): SeatConfig => ({
  id, label: id, adapter: "cli", cliCommand: id, role: "CORRECTNESS", temperature: 0.2, maxTokens: 100, timeoutMs: 1000, enabled: true, tier: "standard", ...extra,
});

test("a codex seat's catalog comes from Codex's own cache and config: the configured default first, hidden models left out", async () => {
  const home = mkdtempSync(join(tmpdir(), "conclave-codexhome-"));
  writeFileSync(join(home, "config.toml"), 'model_provider = "xenia"\nmodel = "gpt-6-sol"\n\n[profiles.fast]\nmodel = "not-top-level"\n');
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
    { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide" },
  ] }));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const catalog = await modelCatalog(seat("codex", { cliModel: "gpt-5.6-terra" }));
    assert.equal(catalog.defaultModel, "gpt-6-sol", "the [profiles] table's model is not the default");
    assert.deepEqual(catalog.models.map((m) => m.id), ["gpt-6-sol", "gpt-5.6-terra"]);
    assert.equal(catalog.current, "gpt-5.6-terra");
    assert.equal(catalog.authoritative, false, "Codex accepts ids outside its cache");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("an antigravity seat's catalog is whatever `agy models` lists, and is authoritative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "conclave-agy-"));
  const agy = join(dir, "agy");
  writeFileSync(agy, '#!/bin/sh\nif [ "$1" = "models" ]; then echo "Fetching available models..."; printf "gemini-3.1-pro-high\\tGemini 3.1 Pro (High)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6\\n"; fi\n');
  chmodSync(agy, 0o755);
  const catalog = await modelCatalog(seat("antigravity", { cliCommand: agy }));
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.authoritative, true);
  assert.deepEqual(catalog.models, [
    { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  ], "the progress line is not a model");
});

test("a xenia seat's catalog is the gateway's listing; an unreachable gateway is reported, not thrown", async () => {
  const listing = (async () => new Response(JSON.stringify({ data: [{ id: "cc/claude-sonnet-5" }, { id: "auto/cheap" }] }), { status: 200 })) as typeof fetch;
  const ok = await modelCatalog(seat("reviewer", { adapter: "xenia", xeniaModel: "cc/claude-sonnet-5" }), { fetchImpl: listing });
  assert.deepEqual(ok.models.map((m) => m.id), ["cc/claude-sonnet-5", "auto/cheap"]);
  assert.equal(ok.authoritative, true);
  const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const failed = await modelCatalog(seat("reviewer", { adapter: "xenia", xeniaModel: "x" }), { fetchImpl: down });
  assert.match(failed.error ?? "", /ECONNREFUSED/);
  assert.deepEqual(failed.models, []);
});

test("claude's catalog is the known ids plus aliases, never a gate", async () => {
  const catalog = await modelCatalog(seat("claude"));
  assert.equal(catalog.authoritative, false);
  assert.ok(catalog.models.some((m) => m.id === "claude-sonnet-5"));
  assert.ok(catalog.models.some((m) => m.id === "opus"));
});

test("per-run overrides replace the right field per adapter and reject what cannot work", () => {
  const seats = [seat("claude"), seat("reviewer", { adapter: "xenia", xeniaModel: "a" }), seat("dummy", { adapter: "fake" })];
  const next = applyModelOverrides(seats, { claude: "claude-opus-5-5", reviewer: "b" });
  assert.equal(next[0]!.cliModel, "claude-opus-5-5");
  assert.equal(next[1]!.xeniaModel, "b");
  assert.equal(seats[0]!.cliModel, undefined, "the configured seats are not mutated");
  assert.equal(applyModelOverrides(seats, { claude: "" })[0]!.cliModel, undefined, "an empty override means the CLI default");
  assert.throws(() => applyModelOverrides(seats, { nosuch: "x" }), /no seat named nosuch/);
  assert.throws(() => applyModelOverrides(seats, { reviewer: "" }), /needs a model/);
  assert.deepEqual(parseModelOverrides(["claude=opus", "codex = gpt-6-sol"]), { claude: "opus", codex: "gpt-6-sol" });
  assert.throws(() => parseModelOverrides(["claude"]), /expected --model <seat>=<model>/);
  assert.throws(() => parseModelOverrides(["=x"]), /expected --model/);
});

test("a codex seat routed through a gateway lists that gateway's Codex models, as the bare ids Codex sends", async () => {
  const home = mkdtempSync(join(tmpdir(), "conclave-codexhome-gw-"));
  writeFileSync(join(home, "config.toml"), 'model_provider = "xenia"\nmodel = "gpt-6-sol"\n\n[model_providers.xenia]\nname = "Xenia"\nbase_url = "http://gateway.test/v1/"\nwire_api = "responses"\n');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  let asked = "";
  const listing = (async (url: string) => {
    asked = String(url);
    return new Response(JSON.stringify({ data: [
      { id: "cx/gpt-6-sol" }, { id: "codex/gpt-6-sol" }, { id: "codex/gpt-6-luna" }, { id: "gpt-5.6-terra" },
      { id: "dva/gpt-6-sol" }, { id: "cc/claude-sonnet-5" }, { id: "auto/cheap" },
    ] }), { status: 200 });
  }) as typeof fetch;
  try {
    const catalog = await modelCatalog(seat("codex"), { fetchImpl: listing });
    assert.equal(asked, "http://gateway.test/v1/models");
    assert.equal(catalog.error, undefined);
    assert.match(catalog.source, /provider "xenia"/);
    assert.deepEqual(catalog.models.map((m) => m.id), ["gpt-6-luna", "gpt-6-sol", "gpt-5.6-terra"], "deduplicated, bare, newest first; other providers' and non-GPT models left out");
    assert.equal(catalog.defaultModel, "gpt-6-sol");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
