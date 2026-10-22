// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "console-scan-"));
try {
  const env = { ...process.env };
  if (env.CLIENT_DATA_TERMS) {
    const file = path.join(dir, "terms");
    writeFileSync(file, env.CLIENT_DATA_TERMS, { mode: 0o600 });
    env.CONSOLE_CLIENT_DATA_TERMS_FILE = file;
  }
  delete env.CLIENT_DATA_TERMS;
  const scanner = new URL("./scan-uploads.py", import.meta.url).pathname;
  const tree = spawnSync("python3", [scanner, "--terms-tree"], { stdio: "inherit", env });
  const result = tree.status === 0 ? spawnSync("python3", [scanner, ...process.argv.slice(2)], { stdio: "inherit", env }) : tree;
  process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
