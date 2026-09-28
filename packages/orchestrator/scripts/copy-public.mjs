#!/usr/bin/env node
// Vendors the web frontend's static assets into this package so the published tarball is
// self-contained. packages/web is intentionally excluded from the pnpm workspace (it has no
// build step, it's just app.js/index.html/styles.css) but an installed @conclave/orchestrator
// package can't reach outside its own node_modules entry to a sibling monorepo package, so we
// copy the assets here at build time instead of resolving them at a monorepo-relative path.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../web/public");
const destination = resolve(here, "../public");

if (!existsSync(source)) {
  console.error(`copy-public: source directory not found: ${source}`);
  process.exit(1);
}

rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
console.log(`copy-public: vendored ${source} -> ${destination}`);
