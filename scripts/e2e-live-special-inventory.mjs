// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { reportIdentities } from "./e2e-live-report.mjs";

const directory = process.argv[2];
const { jobs } = yaml.load(readFileSync(new URL("../.github/workflows/e2e-live.yml", import.meta.url), "utf8"));
for (const browser of ["chromium", "firefox"]) {
  for (const { shard, config, project } of jobs[browser].strategy.matrix.include) {
    const manifest = resolve(directory, `${browser}-${shard}.json`);
    execFileSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--list", `--config=${config}`,
      "--no-deps", `--project=${project}`, "--reporter=json"], {
      env: { ...process.env, E2E_BROWSER: browser, PLAYWRIGHT_JSON_OUTPUT_FILE: manifest },
      stdio: "inherit",
    });
    const report = JSON.parse(readFileSync(manifest, "utf8"));
    assert.deepEqual(report.errors, [], `discovery failed for ${browser}/${shard}`);
    const ids = reportIdentities(report.suites);
    writeFileSync(manifest, JSON.stringify(ids));
    console.log(`${browser}/${shard}: ${ids.length} tests`);
  }
}
