// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const config = JSON.parse(readFileSync("scripts/ci/config.json", "utf8"));
for (const entry of config.quarantine) {
  if (!entry.owner || !entry.test || !Number.isFinite(Date.parse(entry.expires)) || Date.parse(entry.expires) <= Date.now()) throw new Error("quarantine requires a test, owner and future expiry");
}
// No silent retries or exclusions; a quarantine entry remains red until an explicit
// nextest/Playwright policy and its expiry check are reviewed together.
const steps = JSON.parse(process.env.CI_STEPS ?? "{}");
const restored = Object.values(steps).filter((step) => Object.hasOwn(step.outputs ?? {}, "cache-hit"));
const hits = restored.filter((step) => step.outputs["cache-matched-key"] || step.outputs["cache-hit"] === "true").length;
let cacheBytes = null;
if (process.env.CI_CACHE_TOTAL === "1") {
  const data = JSON.parse(execFileSync("gh", ["api", `repos/${process.env.GITHUB_REPOSITORY}/actions/cache/usage`], { encoding: "utf8" }));
  cacheBytes = data.active_caches_size_in_bytes;
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes > config.cacheBudgetBytes) throw new Error("repository cache budget exceeded");
}
const report = { seconds: Math.max(0, Math.floor(Date.now() / 1000) - Number(process.env.CI_STARTED_AT)), cacheHits: hits, cacheLookups: restored.length, cacheBytes };
if (!Number.isFinite(report.seconds)) throw new Error("missing job start time");
mkdirSync(".cache/ci", { recursive: true });
writeFileSync(".cache/ci/metrics.json", JSON.stringify(report));
const directory = ".cache/ci/job-metrics";
const previous = existsSync(directory) ? readdirSync(directory).map((name) => JSON.parse(readFileSync(`${directory}/${name}/metrics.json`, "utf8"))) : [];
const totals = [...previous, report].reduce((sum, item) => ({ seconds: sum.seconds + item.seconds, hits: sum.hits + item.cacheHits, lookups: sum.lookups + item.cacheLookups }), { seconds: 0, hits: 0, lookups: 0 });
const percentage = totals.lookups ? `${Math.round(100 * totals.hits / totals.lookups)}%` : "no cache lookup";
writeFileSync(".cache/ci/summary.md", `| Duration (s) | Cache hits | Cache lookups | Repository cache bytes |\n|---:|---:|---:|---:|\n| ${report.seconds} | ${hits} | ${restored.length} | ${cacheBytes ?? "measured in ci-ok"} |\n\nObserved totals: ${previous.length + 1} jobs/partitions, ${totals.seconds} job-seconds, ${percentage} cache hits.\n`);
