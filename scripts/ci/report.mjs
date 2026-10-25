// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const config = JSON.parse(readFileSync("scripts/ci/config.json", "utf8"));
const steps = JSON.parse(process.env.CI_STEPS ?? "{}");
const restored = Object.values(steps).filter((step) => Object.hasOwn(step.outputs ?? {}, "cache-hit"));
const hits = restored.filter((step) => step.outputs["cache-matched-key"] || step.outputs["cache-hit"] === "true").length;
let cacheBytes = null;
if (process.env.CI_CACHE_TOTAL === "1") {
  const data = JSON.parse(execFileSync("gh", ["api", `repos/${process.env.GITHUB_REPOSITORY}/actions/cache/usage`], { encoding: "utf8" }));
  cacheBytes = data.active_caches_size_in_bytes;
  if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new Error("invalid repository cache usage");
  if (cacheBytes > config.cacheBudgetBytes) process.stdout.write("::warning::Repository cache usage exceeds the budget; prune old entries.\n");
}
const evidence = [".cache/ci/e2e-results/junit.baseline.json", "backend/target/nextest/ci/junit.baseline.json"].filter(existsSync).map((file) => JSON.parse(readFileSync(file, "utf8")));
const pending = evidence.filter((item) => item.comparisonPending);
if (existsSync(".cache/ci/db-collected/comparison.json")) evidence.push(JSON.parse(readFileSync(".cache/ci/db-collected/comparison.json", "utf8")));
for (const item of pending) evidence.splice(evidence.indexOf(item), 1);
const report = { seconds: Math.max(0, Math.floor(Date.now() / 1000) - Number(process.env.CI_STARTED_AT)), cacheHits: hits, cacheLookups: restored.length, cacheBytes, baselineReds: evidence.reduce((n, item) => n + item.baselineReds.length, 0), newReds: evidence.reduce((n, item) => n + item.newReds.length, 0), fixed: evidence.reduce((n, item) => n + (item.fixed?.length ?? 0), 0) };
if (!Number.isFinite(report.seconds)) throw new Error("missing job start time");
mkdirSync(".cache/ci", { recursive: true });
writeFileSync(".cache/ci/metrics.json", JSON.stringify(report));
const directory = ".cache/ci/job-metrics";
const previous = existsSync(directory) ? readdirSync(directory).map((name) => JSON.parse(readFileSync(`${directory}/${name}/metrics.json`, "utf8"))) : [];
const totals = [...previous, report].reduce((sum, item) => ({ seconds: sum.seconds + item.seconds, hits: sum.hits + item.cacheHits, lookups: sum.lookups + item.cacheLookups }), { seconds: 0, hits: 0, lookups: 0 });
const percentage = totals.lookups ? `${Math.round(100 * totals.hits / totals.lookups)}%` : "no cache lookup";
writeFileSync(".cache/ci/summary.md", `| Duration (s) | Cache hits | Cache lookups | Repository cache bytes |\n|---:|---:|---:|---:|\n| ${report.seconds} | ${hits} | ${restored.length} | ${cacheBytes ?? "measured in ci-ok"} |\n\nObserved totals: ${previous.length + 1} jobs/partitions, ${totals.seconds} job-seconds, ${percentage} cache hits.\n`);
const reds = [...previous, report].reduce((sum, item) => ({ known: sum.known + (item.baselineReds ?? 0), fresh: sum.fresh + (item.newReds ?? 0), fixed: sum.fixed + (item.fixed ?? 0) }), { known: 0, fresh: 0, fixed: 0 });
writeFileSync(".cache/ci/summary.md", `\nTest baseline: ${reds.known} known reds (reported, non-blocking), ${reds.fresh} new reds, ${reds.fixed} fixed (remove from baseline). Exact IDs are in scanned JUnit baseline artifacts.\n`, { flag: "a" });
for (const item of pending) writeFileSync(".cache/ci/summary.md", `\nDB source ${item.source} at ${item.sha}: ${item.newReds.length} failed observations; classification awaits this run's paired receipts in ci-ok.\n`, { flag: "a" });

const planned = Object.values(steps).find((step) => step.outputs?.budget)?.outputs.budget;
if (planned) {
  const budget = JSON.parse(planned);
  writeFileSync(".cache/ci/summary.md", `\nPlan budget: ${budget.jobs}/${config.maxJobs} jobs, ${budget.minutes}/${config.maxTotalMinutes} estimated job-minutes; timeout chain ${budget.wallMinutes}/${budget.queueMinutes} minutes.\n\nPredicted per-job minutes: ${JSON.stringify(budget.perJob)}\n`, { flag: "a" });
}

const entries = JSON.parse(readFileSync(config.quarantineFile, "utf8"));
const flaky = entries.filter((entry) => entry.class === "flaky").length;
writeFileSync(".cache/ci/summary.md", `\nFlaky quarantine: ${flaky}/${config.baselineMaxFlaky} entries (passes and failures accepted; evidence required).\n`, { flag: "a" });
for (const entry of entries) {
  if (Date.parse(entry.expires) - Date.now() <= 7 * 86400_000) writeFileSync(".cache/ci/summary.md", `\nExpiry D-7: ${entry.owner} / ${entry.suite} / ${entry.expires}.\n`, { flag: "a" });
}
