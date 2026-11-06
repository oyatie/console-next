// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const root = process.env.CONSOLE_TEST_ROOT ?? path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("live E2E builds one candidate and runs at most four Chromium shards before Firefox", () => {
  const workflow = yaml.load(read(".github/workflows/e2e-live.yml"));
  assert.deepEqual(workflow.on.push.branches, ["dev"]);
  assert.ok(workflow.on.schedule.length);
  assert.equal(workflow.on.merge_group, undefined);
  assert.equal(workflow.concurrency.group, "e2e-live-${{ github.ref }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);

  const { build, chromium, firefox } = workflow.jobs;
  const cargo = build.steps.find((step) => step.run?.includes("cargo build"));
  assert.match(cargo.run, /--release/);
  assert.match(cargo.run, /full,e2e-test-support/);
  const artifact = build.steps.find((step) => step.uses?.startsWith("actions\/upload-artifact@"));
  assert.ok(artifact);
  assert.deepEqual(chromium.needs, ["build"]);
  assert.deepEqual(firefox.needs, ["build", "chromium"]);
  assert.match(firefox.if, /needs\.build\.result == 'success'/);
  for (const job of [chromium, firefox]) {
    assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4]);
    assert.equal(job.strategy["max-parallel"], 4);
    assert.ok(job.services.postgres.image.includes("@sha256:"));
    assert.ok(job.steps.some((step) => step.uses?.startsWith("actions\/download-artifact@") && step.with.name === artifact.with.name));
    const run = job.steps.find((step) => step.run?.includes("e2e-live-report.mjs"));
    assert.ok(run);
    assert.match(run.run, /--retries=0/, "live E2E must report flakes instead of retrying them green");
    assert.match(run.env.CONSOLE_DEV_POSTGRES_CONTAINER, /job\.services\.postgres\.id/);
  }
});

test("the workflow reaches every previously dormant Playwright surface", () => {
  const source = read(".github/workflows/e2e-live.yml");
  for (const file of [
    "playwright.coldstart.config.ts",
    "playwright.live-renew.config.ts",
    "playwright.navigation.config.ts",
    "e2e/mock/focus-stress.config.ts",
    "apps/web/src/features/people/ui/grid-table.playwright.ts",
    "apps/web/src/ui/timeline-lanes/timeline-line.playwright.ts",
  ]) assert.ok(source.includes(file), file);
  assert.match(source, /--project=clock/);
});

test("the service image is the repository's pinned E2E Postgres image", () => {
  const compose = yaml.load(read("deploy/dev/compose.e2e.yml"));
  const workflow = yaml.load(read(".github/workflows/e2e-live.yml"));
  for (const name of ["chromium", "firefox"])
    assert.equal(workflow.jobs[name].services.postgres.image, compose.services.postgres.image);
});

test("route load runs only nightly or manually without delaying live E2E", () => {
  const live = yaml.load(read(".github/workflows/e2e-live.yml"));
  const workflow = yaml.load(read(".github/workflows/route-load.yml"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.ok(workflow.on.schedule.length);
  assert.equal(live.jobs["route-load"], undefined);
  assert.equal(workflow.concurrency.group, "route-load-${{ github.ref }}");
  assert.notEqual(workflow.concurrency.group, live.concurrency.group);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const build = workflow.jobs.build;
  assert.ok(build.steps.some(step => step.run?.includes("cargo build --release --locked -p console-app --features full,e2e-test-support")));
  assert.ok(build.steps.some(step => step.run === "npm run build"));
  assert.ok(build.steps.some(step => step.with?.name === "e2e-live-runtime"));
});

test("route load publishes failed measurements against the served synthetic tenant", () => {
  const workflow = yaml.load(read(".github/workflows/route-load.yml"));
  const job = workflow.jobs["route-load"];
  assert.ok(job, "route-load needs a scheduled producer");
  assert.deepEqual(job.needs, ["build"]);
  assert.equal(job.env.E2E_SERVED, "1");
  assert.equal(job.env.E2E_PREBUILT, "1");
  assert.equal(job.env.E2E_PERF, "1");
  assert.equal(job.env.E2E_WORKERS, "1");
  const compose = yaml.load(read("deploy/dev/compose.e2e.yml"));
  assert.equal(job.services.postgres.image, compose.services.postgres.image);
  assert.ok(job.steps.some(step => step.uses?.startsWith("actions/download-artifact@") && step.with.name === "e2e-live-runtime"));
  const probe = job.steps.find(step => step.run?.includes("e2e/perf/route-load.spec.ts"));
  assert.match(probe.run, /--project=parallel/);
  assert.match(probe.run, /--retries=0/);
  assert.equal(probe.env.CONSOLE_DEV_POSTGRES_CONTAINER, "${{ job.services.postgres.id }}");
  const upload = job.steps.find(step => step.with?.name === "route-load-evidence");
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.with.path, "${{ runner.temp }}/route-load/route-load.json");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(probe.env.PERF_EVIDENCE_DIR, "${{ runner.temp }}/route-load");
  assert.equal(job.env.PERF_EVIDENCE_DIR, undefined, "runner context is only available at step scope");
  assert.ok(!job.steps.some(step => step.run?.includes("cargo build")), "reuse the candidate binary");
});
