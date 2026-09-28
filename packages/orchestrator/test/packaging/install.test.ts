import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
// test/packaging -> test -> orchestrator -> packages -> repo root
const repoRoot = resolve(here, "../../../..");
const corePkgDir = resolve(repoRoot, "packages/core");
const orchestratorPkgDir = resolve(repoRoot, "packages/orchestrator");

// These are real `pnpm pack` + `npm install` round trips against real tarballs and a real
// temp project — the only way to actually catch "works from the published package" bugs
// (missing files, wrong bin paths, monorepo-relative paths that don't survive installation).
// They're slower than a unit test; that's the tradeoff for testing the thing we actually ship.

let tarDir: string;
let installDir: string;
let coreTarball: string;
let orchestratorTarball: string;

async function packTarball(pkgDir: string, destDir: string): Promise<string> {
  const existingNames = new Set(existsSync(destDir) ? await readdir(destDir) : []);
  await execFileAsync("pnpm", ["pack", "--pack-destination", destDir], { cwd: pkgDir });
  const afterNames = await readdir(destDir);
  const created = afterNames.find((name) => name.endsWith(".tgz") && !existingNames.has(name));
  assert.ok(created, `pnpm pack in ${pkgDir} did not produce a new .tgz in ${destDir}`);
  return join(destDir, created);
}

before(async () => {
  // The published tarball must contain compiled output — if dist/ (or the vendored public/)
  // is missing, this suite is running against stale/unbuilt source and every assertion below
  // would be meaningless, so fail fast with a clear message instead of a confusing pack/install error.
  for (const [name, dir] of [
    ["packages/core", corePkgDir],
    ["packages/orchestrator", orchestratorPkgDir],
  ] as const) {
    assert.ok(existsSync(join(dir, "dist")), `${name}/dist is missing — run \`pnpm build\` before this suite`);
  }
  assert.ok(existsSync(join(orchestratorPkgDir, "public", "index.html")), "orchestrator/public is missing — run `pnpm build` (copy-public step) before this suite");

  tarDir = await mkdtemp(join(tmpdir(), "conclave-pack-"));
  installDir = await mkdtemp(join(tmpdir(), "conclave-install-"));

  coreTarball = await packTarball(corePkgDir, tarDir);
  orchestratorTarball = await packTarball(orchestratorPkgDir, tarDir);

  await execFileAsync("npm", ["init", "-y"], { cwd: installDir });
  await execFileAsync("npm", ["install", coreTarball, orchestratorTarball], { cwd: installDir, timeout: 120_000 });
});

test("packaged tarball excludes source, tests, and runtime/dev artifacts", async () => {
  const { stdout } = await execFileAsync("tar", ["-tzf", orchestratorTarball]);
  const entries = stdout.split("\n").filter(Boolean);

  assert.ok(entries.some((e) => e.includes("dist/cli/index.js")), "tarball must contain the compiled CLI entrypoint");
  assert.ok(entries.some((e) => e.includes("dist/web.js")), "tarball must contain the compiled web entrypoint");
  assert.ok(entries.some((e) => e.includes("dist/http/server.js")), "tarball must contain the compiled server code");
  assert.ok(entries.some((e) => e.includes("public/index.html")), "tarball must contain packages/web/public's index.html");
  assert.ok(entries.some((e) => e.includes("public/app.js")), "tarball must contain packages/web/public's app.js");

  const forbidden = [/(^|\/)src\//, /(^|\/)test\//, /\.db(-journal)?$/, /\.env/, /(^|\/)\.conclave\//, /(^|\/)node_modules\//, /\.log$/];
  for (const entry of entries) {
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(entry), `tarball entry "${entry}" matches forbidden pattern ${pattern} (secrets/db/logs/fixtures/dev artifacts must not ship)`);
    }
  }
});

test("installed CLI bin runs without any repository-relative path", async () => {
  const binPath = join(installDir, "node_modules", ".bin", "conclave");
  assert.ok(existsSync(binPath), "node_modules/.bin/conclave must exist after installation");

  const { stdout: helpOut } = await execFileAsync(binPath, ["--help"], { cwd: installDir });
  assert.match(helpOut, /Usage: conclave run/);
  assert.match(helpOut, /conclave doctor/);

  const { stdout: noArgsOut } = await execFileAsync(binPath, [], { cwd: installDir }).catch((error) => error);
  assert.match(noArgsOut ?? "", /Usage: conclave run/);
});

test("installed CLI status command reads a real session db end-to-end", async () => {
  const { EventStore } = await import(join(installDir, "node_modules", "@conclave", "orchestrator", "dist", "store", "eventStore.js"));
  const dbPath = join(installDir, "smoke.db");
  const store = new EventStore(dbPath);
  try {
    store.append("smoke-session", { type: "SessionCreated", payload: { sessionId: "smoke-session", task: "packaging smoke test", budgetCeilingUsd: 5, minQuorum: 1 } });
  } finally {
    store.close();
  }

  const binPath = join(installDir, "node_modules", ".bin", "conclave");
  const { stdout } = await execFileAsync(binPath, ["status", "smoke-session", "--db", dbPath], { cwd: installDir });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.sessionId, "smoke-session");
  assert.equal(parsed.task, "packaging smoke test");
});

test("installed web server starts and serves vendored static assets from the package, not the monorepo", async () => {
  const webPath = join(installDir, "node_modules", "@conclave", "orchestrator", "dist", "web.js");
  const registryPath = join(installDir, "smoke-registry.db");
  const port = 41000 + Math.floor(Math.random() * 4000);

  const child = spawn(process.execPath, [webPath], {
    cwd: installDir,
    env: { ...process.env, CONCLAVE_PORT: String(port), CONCLAVE_SESSION_REGISTRY_PATH: registryPath },
    stdio: "ignore",
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    // Poll for readiness instead of a fixed sleep — bounded, so a genuinely broken startup fails fast.
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/sessions`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, "installed web server did not become ready within 10s");

    for (const [path, contentType] of [
      ["/", "text/html"],
      ["/app.js", "javascript"],
      ["/styles.css", "css"],
    ] as const) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, `${path} should be served from the installed package's vendored public/ dir`);
      assert.match(res.headers.get("content-type") ?? "", new RegExp(contentType));
    }
  } finally {
    child.kill();
  }
});

test("doctor reports actionable per-seat diagnostics (installed or missing) without crashing", async () => {
  const binPath = join(installDir, "node_modules", ".bin", "conclave");
  const { stdout } = await execFileAsync(binPath, ["doctor"], { cwd: installDir, timeout: 60_000 }).catch((error) => error);

  for (const seat of ["claude", "codex", "antigravity"]) {
    assert.match(stdout, new RegExp(seat), `doctor output should mention the "${seat}" seat`);
  }
  assert.match(stdout, /OK|FAIL|MISSING/, "doctor output should classify each seat's status");
});

after(async () => {
  await rm(tarDir, { recursive: true, force: true }).catch(() => {});
  await rm(installDir, { recursive: true, force: true }).catch(() => {});
});
