// SPDX-License-Identifier: LicenseRef-Proprietary
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { reportIdentities } from "./e2e-live-report.mjs";
import { listedTests, plan, readTimings } from "./e2e-timings.mjs";

export function livePlan(report, timings = {}) {
  if (report.errors?.length) throw new Error("LIVE_DISCOVERY_FAILED");
  const tests = listedTests(report);
  // A shard lists bare spec paths, which run a file's tests in every project listing them: a test in two projects (two
  // browsers in one inventory) would run twice. Projects that split a file's tests (the mock suite's styles) plan as one.
  const ids = tests.map(test => test.key.slice(test.key.indexOf(" › ")));
  if (!tests.length || new Set(ids).size !== ids.length) throw new Error("LIVE_INVALID_INVENTORY");
  const project = [...new Set(tests.map(test => test.project))].join("+");
  const shards = plan(tests.map(test => ({ ...test, project })), timings, { target: 2400, boot: 300, workers: 2, strict: true, minShards: 8 });
  if (shards.length < 8) throw new Error("LIVE_SHARD_CAPACITY: expected at least eight nonempty shards within 40 minutes");
  // Explicitly skipped files must remain visible in the live reports.
  const planned = new Set(shards.flatMap(shard => shard.files));
  for (const { file } of report.suites) if (!planned.has(file)) shards.at(-1).files.push(file);
  return shards;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, browser] = process.argv.slice(2);
  const inventory = JSON.parse(readFileSync(input, "utf8"));
  const shards = livePlan(inventory, readTimings());
  const auxiliaryJobs = { chromium: 6, firefox: 5, "firefox-states": 0 };
  if (!Object.hasOwn(auxiliaryJobs, browser) || shards.length + auxiliaryJobs[browser] > 256)
    throw new Error("LIVE_SHARD_CAPACITY: unsupported browser or matrix exceeds 256 jobs");
  mkdirSync(output, { recursive: true });
  const byFile = new Map(inventory.suites.map(suite => [suite.file, suite]));
  shards.forEach((shard, index) => {
    const prefix = path.join(output, `${browser}-${index + 1}`);
    writeFileSync(`${prefix}.txt`, `${shard.files.join("\n")}\n`);
    writeFileSync(`${prefix}.json`, JSON.stringify(reportIdentities(shard.files.map(file => byFile.get(file)))));
  });
  if (process.env.GITHUB_OUTPUT) {
    const indices = shards.map((_, index) => index + 1);
    appendFileSync(process.env.GITHUB_OUTPUT, `${browser}=${JSON.stringify(indices)}\n${browser}-count=${indices.length}\n`);
  }
  writeFileSync(path.join(output, `${browser}.json`), `${JSON.stringify(shards, null, 2)}\n`);
  console.log(shards.map((shard, index) => `${browser} ${index + 1}: estimated ${shard.est}s, ${shard.files.length} specs`).join("\n"));
}
