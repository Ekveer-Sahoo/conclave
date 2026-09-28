#!/usr/bin/env node
// Ensures the compiled bin entry points are executable in the packed tarball. tsc preserves the
// shebang line but not the execute bit, and some install/extraction paths rely on the bit already
// being set in the tarball rather than being fixed up by the installer.
import { chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binFiles = [resolve(here, "../dist/cli/index.js"), resolve(here, "../dist/web.js")];

for (const file of binFiles) {
  chmodSync(file, 0o755);
  console.log(`chmod-bin: set executable bit on ${file}`);
}
