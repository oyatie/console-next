// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listedTests, plan, readTimings } from "./e2e-timings.mjs";

export function livePlan(report, timings = {}) {
  if (report.errors?.length) throw new Error("LIVE_DISCOVERY_FAILED");
  const tests = listedTests(report);
  if (!tests.length || new Set(tests.map(test => test.project)).size !== 1) throw new Error("LIVE_INVALID_INVENTORY");
  const shards = plan(tests, timings, { target: 2400, boot: 300, workers: 2, strict: true, minShards: 8 });
  if (shards.length !== 8) throw new Error("LIVE_SHARD_CAPACITY: expected eight nonempty shards within 40 minutes");
  // Explicitly skipped files must remain visible in the live reports.
  const planned = new Set(shards.flatMap(shard => shard.files));
  for (const { file } of report.suites) if (!planned.has(file)) shards.at(-1).files.push(file);
  return shards;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output, browser] = process.argv.slice(2);
  const shards = livePlan(JSON.parse(readFileSync(input, "utf8")), readTimings());
  mkdirSync(output, { recursive: true });
  shards.forEach((shard, index) => writeFileSync(path.join(output, `${browser}-${index + 1}.txt`), `${shard.files.join("\n")}\n`));
  writeFileSync(path.join(output, `${browser}.json`), `${JSON.stringify(shards, null, 2)}\n`);
  console.log(shards.map((shard, index) => `${browser} ${index + 1}: estimated ${shard.est}s, ${shard.files.length} specs`).join("\n"));
}
