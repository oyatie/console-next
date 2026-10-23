// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

import "./ci-cutover.test.mjs";

const root = new URL("../", import.meta.url);
const workflow = () => load(readFileSync(new URL(".github/workflows/ci.yml", root), "utf8"));
const helpers = () => import("./ci/plan.mjs");
function mandatory(step, label, allowedIf) {
  assert.ok(step, `${label}: missing enforcement`);
  assert.ok(step["continue-on-error"] === undefined || step["continue-on-error"] === false, `${label}: optional enforcement`);
  assert.ok(step.if === undefined || (allowedIf !== undefined && [allowedIf].flat().includes(step.if)), `${label}: skippable enforcement`);
  assert.doesNotMatch(step.run ?? "", /\|\|\s*(?:true|:)(?:\s|$)/, `${label}: ignored failure`);
}
const packages = [
  { name: "core", manifest_path: "/repo/backend/core/Cargo.toml", dependencies: [], targets: [{ name: "core", kind: ["lib"], test: true }] },
  { name: "app", manifest_path: "/repo/backend/app/Cargo.toml", dependencies: [{ name: "core", path: "/repo/backend/core" }], targets: [{ name: "app", kind: ["bin"], test: true }] },
  { name: "other", manifest_path: "/repo/backend/other/Cargo.toml", dependencies: [] },
];

test("docs skip proof jobs; crate changes include reverse dependencies only", async () => {
  const { affected } = await helpers();
  assert.deepEqual(affected(["docs/ci.md"], packages, [], "/repo").crates, []);
  const plan = affected(["backend/core/src/lib.rs"], packages, [], "/repo");
  assert.deepEqual(plan.crates, ["app", "core"]);
  assert.equal(plan.backend, true);
  assert.equal(plan.web, false);
  assert.equal(plan.e2e, true);
  assert.equal(affected(["backend/other/src/lib.rs"], packages, [], "/repo").e2e, false);
});

test("shared inputs and release units force full proof; unknown paths fail safe", async () => {
  const { affected } = await helpers();
  for (const file of ["backend/Cargo.lock", "package-lock.json", ".github/workflows/ci.yml", "backend/core/migrations/new.sql", "new-tool/input"]) {
    assert.equal(affected([file], packages, [], "/repo").full, true, file);
  }
  assert.equal(affected(["docs/ci.md"], packages, [], "/repo", true).full, true);
});

test("merge-group CLI uses its base SHA for affected docs-only fast proof", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-merge-plan-"));
  try {
    writeFileSync(path.join(dir, "event.json"), JSON.stringify({ merge_group: { base_sha: "base-sha" } }));
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ packages }))});\n`, { mode: 0o700 });
    writeFileSync(path.join(dir, "git"), `#!${process.execPath}\nprocess.stdout.write('docs/ci.md\\0');\n`, { mode: 0o700 });
    const output = path.join(dir, "outputs");
    const result = spawnSync(process.execPath, ["scripts/ci/plan.mjs"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_EVENT_PATH: path.join(dir, "event.json"), GITHUB_EVENT_NAME: "merge_group", GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    assert.equal(values.full, "false");
    assert.equal(values.tier, "fast");
    assert.equal(JSON.parse(values.build).full, false);
    assert.equal(JSON.parse(values.required).hygiene, true);
    assert.equal(values.e2e, "false");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("npm workspace reverse dependencies reach their consumers", async () => {
  const { affected } = await helpers();
  const npm = [{ name: "api", dir: "packages/api", dependencies: {} }, { name: "web", dir: "apps/web", dependencies: { api: "*" } }];
  assert.deepEqual(affected(["packages/api/src/index.ts"], packages, npm, "/repo").workspaces, ["api", "web"]);
});

test("ci-ok rejects dependency-failure skips, cancellation, and missing results", async () => {
  const { gate } = await import("./ci/gate.mjs");
  assert.equal(gate({ build: true, test: true }, { build: "failure", test: "skipped" }), false);
  assert.equal(gate({ test: true }, { test: "skipped" }), false);
  assert.equal(gate({ test: true }, { test: "cancelled" }), false);
  assert.equal(gate({ test: true }, {}), false);
  assert.equal(gate({ test: false }, { test: "skipped" }), true);
  assert.equal(gate({ test: true }, { test: "success" }), true);
  assert.equal(gate({ test: false }, { test: "failure" }), false);
  assert.equal(gate({ test: true }, { test: "success", unplanned: "skipped" }), false);
});

test("every proof job feeds an always-reporting merge-queue gate", async () => {
  const wf = workflow();
  assert.ok(Object.hasOwn(wf.on, "merge_group"));
  assert.deepEqual(wf.permissions, {});
  assert.equal(wf.jobs["ci-ok"].if, "always()");
  mandatory(wf.jobs["ci-ok"], "ci-ok", "always()");
  const enforcement = wf.jobs["ci-ok"].steps.find((step) => step.run?.trim() === "node scripts/ci/gate.mjs");
  mandatory(enforcement, "ci-ok");
  assert.equal(enforcement.env?.NEEDS, "${{ toJSON(needs) }}");
  assert.equal(wf.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.deepEqual([...wf.jobs["ci-ok"].needs].sort(), Object.keys(wf.jobs).filter((x) => x !== "ci-ok").sort());
  for (const name of ["backend-test", "backend-db", "e2e", "personal-data-classification", "pii-no-logs", "tenant-isolation", "rls-arming", "audit-coverage"]) assert.ok(wf.jobs[name], name);
  const { requiredJobs } = await helpers();
  assert.equal(requiredJobs({}).hygiene, true);
  assert.deepEqual(Object.keys(requiredJobs({})).sort(), Object.keys(wf.jobs).filter((name) => !["ci-ok", "plan"].includes(name)).sort());
});

test("proof jobs execute their required commands without optional steps", () => {
  const wf = workflow();
  for (const name of ["personal-data-classification", "pii-no-logs", "tenant-isolation", "rls-arming", "audit-coverage"]) {
    const command = new RegExp(`^\\s*(?:\\S*/)?console-gate-${name}\\s*$`, "m");
    mandatory(wf.jobs[name], name, "needs.plan.outputs.backend == 'true'");
    mandatory(wf.jobs[name].steps.find((step) => command.test(step.run ?? "")), name);
  }
  for (const [name, command] of [["backend-test", "rust-tests\\.mjs\\s+unit"], ["backend-db", "rust-tests\\.mjs\\s+db"], ["e2e", "e2e\\.mjs\\s+run"]]) {
    mandatory(wf.jobs[name], name, `needs.plan.outputs.${name === "e2e" ? "e2e" : name === "backend-test" ? "unit" : "db"} == 'true'`);
    const run = new RegExp(`^\\s*node\\s+(?:\\.\\./)?scripts/ci/${command}(?:\\s|$)`, "m");
    mandatory(wf.jobs[name].steps.find((step) => run.test(step.run ?? "")), name);
  }
});

test("hygiene always enforces structural scans, fixture checks, terms and secrets", () => {
  const job = workflow().jobs.hygiene;
  mandatory(job, "hygiene");
  for (const command of [/^\s*python3 scripts\/client-data-scan\.py --root \. --tree\s*$/m, /^\s*python3 scripts\/ci\/scan-uploads\.py --terms-tree\s*$/m, /^\s*gitleaks git\s/m, /^\s*node scripts\/check-fixture-ids\.mjs\s*$/m, /^\s*node scripts\/check-e2e-identifiers\.mjs\s*$/m]) {
    mandatory(job.steps.find((step) => command.test(step.run ?? "")), String(command));
  }
  const baseline = job.steps.find((step) => step.run === "python3 scripts/ci/test-results.py --validate");
  mandatory(baseline, "trunk baseline");
  assert.equal(baseline.env?.CI_BASE_SHA, "${{ needs.plan.outputs.base }}");
});

test("all actions are allowed and SHA pinned; every job is bounded and hardened", () => {
  for (const file of readdirSync(new URL(".github/workflows/", root)).filter((file) => /\.ya?ml$/.test(file))) {
    const wf = load(readFileSync(new URL(`.github/workflows/${file}`, root), "utf8"));
    assert.equal(wf.on.pull_request_target, undefined);
    for (const [name, job] of Object.entries(wf.jobs)) {
      assert.ok(job["timeout-minutes"] > 0, `${file}:${name}`);
      assert.match(job.steps[0].uses, /^step-security\/harden-runner@[a-f0-9]{40}$/);
      assert.equal(job.steps[0].with["egress-policy"], "block", `${file}:${name}`);
      assert.ok(job.steps[0].with["allowed-endpoints"]);
      for (const step of job.steps) if (step.uses) assert.match(step.uses, /^(actions\/[a-z/-]+|step-security\/harden-runner)@[a-f0-9]{40}$/);
    }
  }
});

test("cache writes are dev-push only; uploads have a preceding successful personal-data scan", () => {
  const wf = workflow();
  for (const [name, job] of Object.entries(wf.jobs)) {
    for (const [i, step] of job.steps.entries()) {
      if (/^actions\/cache\/save@/.test(step.uses ?? "")) {
        assert.match(step.if, /github.event_name == 'push'/);
        assert.match(step.if, /github.ref == 'refs\/heads\/dev'/);
      }
      if (/^actions\/(upload-artifact|cache\/save)@/.test(step.uses ?? "")) {
        const scan = job.steps.slice(0, i).findLast((s) => s.id === "privacy");
        assert.ok(scan, `${name}: upload without privacy scan`);
        assert.match(step.if, /steps.privacy.outcome == 'success'/);
        if (step.uses.startsWith("actions/upload-artifact")) {
          assert.match(String(step.with["retention-days"]), /retention/);
          assert.match(step.if, /outputs\.retention != ''/, "missing plans must not use the repository's default retention");
        }
      }
      if (step.uses?.startsWith("actions/setup-node")) {
        assert.equal(step.with?.cache, undefined, "implicit saves violate restore-only PR policy");
        assert.equal(step.with["package-manager-cache"], false);
      }
    }
  }
});

test("dev ruleset requires PR, queue and ci-ok without bypass or human approval", () => {
  const rule = JSON.parse(readFileSync(new URL(".github/rulesets/dev.json", root), "utf8"));
  assert.deepEqual(rule.bypass_actors, []);
  assert.deepEqual(rule.conditions.ref_name.include, ["refs/heads/dev"]);
  const byType = Object.fromEntries(rule.rules.map((r) => [r.type, r.parameters]));
  for (const type of ["pull_request", "merge_queue", "required_status_checks", "non_fast_forward", "deletion"]) assert.ok(Object.hasOwn(byType, type), type);
  assert.equal(byType.pull_request.required_approving_review_count, 0);
  assert.deepEqual(byType.required_status_checks.required_status_checks, [{ context: "ci-ok", integration_id: 15368 }]);
  assert.equal(byType.required_status_checks.strict_required_status_checks_policy, false);
});

test("duration shards cover every file once and reserve solo for shard one", async () => {
  const { shards } = await import("./ci/e2e.mjs");
  const tests = ["slow.spec.ts", "first-run-solo.spec.ts", "other.spec.ts"].map((file) => ({ project: "parallel", file, key: file }));
  const jobs = shards(tests, Object.fromEntries(tests.map((t) => [t.key, { s: 400 }])), { e2eTargetSeconds: 300, e2eWorkers: 2 });
  assert.ok(jobs.length > 1);
  assert.ok(jobs[0].files.includes("first-run-solo.spec.ts"));
  assert.deepEqual(jobs.flatMap((job) => job.files).sort(), tests.map((t) => t.file).sort());
  for (const job of jobs) assert.equal(job.est, Math.round(40 + job.files.length * 400 / 2), "reserving solo must preserve measured bin sizes");
});

test("upload scan rejects valid identifiers and accepts mismatched checksums", () => {
  const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const check = (10 - (weights.reduce((sum, w, i) => sum + digits[i] * w, Math.floor(digits[8] * 5 / 10)) % 10)) % 10;
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-split-id-"));
  try {
    const body = (digit) => "x".repeat(1024 * 1024 - 4) + "\n" + digits.slice(0, 3).join("") + "-" + digits.slice(3, 5).join("") + "-" + digits.slice(5).join("") + digit;
    const run = () => spawnSync("node", ["scripts/ci/privacy.mjs", dir], { encoding: "utf8" });
    writeFileSync(path.join(dir, "payload"), body(check));
    assert.equal(run().status, 1);
    writeFileSync(path.join(dir, "payload"), body((check + 1) % 10));
    assert.equal(run().status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all three Clippy feature sets keep -D warnings", () => {
  const jobs = Object.entries(workflow().jobs);
  for (const features of ["", "--features full ", "--features full,test-postgres "]) {
    const command = `cargo clippy --workspace --all-targets --locked ${features}-- -D warnings`;
    const matches = jobs.flatMap(([name, job]) => job.steps.filter((step) => step.run?.split("\n").some((line) => line.trim() === command)).map((step) => ({ name, job, step })));
    assert.ok(matches.length > 0, `missing strict ${features || "default"} lint`);
    for (const { name, job, step } of matches) {
      mandatory(job, name, ["needs.plan.outputs.backend == 'true'", "needs.plan.outputs.backend == 'true' || needs.plan.outputs.e2e == 'true'"]);
      mandatory(step, command, "needs.plan.outputs.backend == 'true'");
    }
  }
});

test("Telegram adapter keeps credentials out of argv and sends only the supplied run metadata", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-notify-"));
  try {
    const capture = path.join(dir, "capture.json");
    writeFileSync(path.join(dir, "curl"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(process.env.CAPTURE,JSON.stringify({args,config:fs.readFileSync(args[args.indexOf('-K')+1],'utf8'),body:fs.readFileSync(0,'utf8')}));process.stdout.write('{"ok":true}\\n200');\n`, { mode: 0o700 });
    const token = `1:${randomBytes(24).toString("hex")}`;
    const result = spawnSync("bash", ["scripts/ci/notify-telegram.sh", "send", "page", "page", "console probe failed"], {
      input: "Run https://example.invalid/actions/runs/1.\n", encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CAPTURE: capture, CONSOLE_TELEGRAM_BOT_TOKEN: token, CONSOLE_TELEGRAM_CHAT_ID: "-1", NOTIFY_TELEGRAM_GAP: "0" },
    });
    assert.equal(result.status, 0, result.stderr);
    const sent = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(sent.args.some((arg) => arg.includes(token)), false);
    assert.ok(sent.config.includes(`/bot${token}/sendMessage`));
    assert.equal(sent.args.includes("disable_notification=true"), false);
    assert.equal(sent.body, "console probe failed\n\nRun https://example.invalid/actions/runs/1.\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Telegram refuses malformed credentials before making a request", () => {
  const result = spawnSync("bash", ["scripts/ci/notify-telegram.sh", "send", "page", "page", "console probe failed"], {
    encoding: "utf8", env: { ...process.env, CONSOLE_TELEGRAM_BOT_TOKEN: "invalid", CONSOLE_TELEGRAM_CHAT_ID: "-1" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /malformed/);
});

test("DB test setup derives the guarded admin and connection marker from the migration", async () => {
  const { dbContract, parseDbContract, sqlxUrl } = await import("./ci/db-contract.mjs");
  const contract = dbContract();
  const sql = readFileSync(new URL("backend/crates/platform/db/migrations/0196_platform_force_command_and_fk_closure.sql", root), "utf8");
  assert.ok(sql.includes(`CURRENT_USER <> '${contract.admin}'`));
  assert.ok(sql.includes(`'${contract.marker}'`));
  assert.equal(new URL(sqlxUrl("postgres://localhost/test")).searchParams.get("options"), `-c ${contract.key}=${contract.marker}`);
  assert.throws(() => parseDbContract("SELECT 1"), /contract changed/);
  assert.equal(workflow().jobs["backend-db"].services.postgres.env.POSTGRES_USER, "${{ needs.plan.outputs.testAdmin }}");
});

test("service preparation exports guarded URLs and refuses invalid ports", async () => {
  const { dbContract } = await import("./ci/db-contract.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-db-env-"));
  try {
    const envFile = path.join(dir, "github-env");
    const env = { ...process.env, PG_PORT: "5432", PG_ADMIN_PASSWORD: randomBytes(24).toString("hex"), RUNNER_TEMP: dir, GITHUB_ENV: envFile };
    const result = spawnSync("node", ["scripts/ci/prepare-db.mjs"], { encoding: "utf8", env });
    assert.equal(result.status, 0);
    const values = Object.fromEntries(readFileSync(envFile, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const url = new URL(values.DATABASE_URL);
    const contract = dbContract();
    assert.equal(url.username, contract.admin);
    assert.equal(url.searchParams.get("options"), `-c ${contract.key}=${contract.marker}`);
    assert.ok(result.stdout.includes("::add-mask::"));
    assert.notEqual(values.CONSOLE_TEST_RUNTIME_PASSWORD, values.CONSOLE_TEST_FORCE_PASSWORD);
    assert.notEqual(spawnSync("node", ["scripts/ci/prepare-db.mjs"], { encoding: "utf8", env: { ...env, PG_PORT: "99999" } }).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("browser failures retain traces without automatic retries", () => {
  const config = readFileSync(new URL("playwright.config.ts", root), "utf8");
  assert.match(config, /retries: 0/);
  assert.match(config, /mode: "retain-on-failure"/);
  assert.doesNotMatch(config, /on-first-retry/);
});

test("job metrics count fallback cache hits and publish budgets and D-7 quarantine warnings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-job-metrics-"));
  try {
    const config = JSON.parse(readFileSync(new URL("scripts/ci/config.json", root), "utf8"));
    const script = new URL("scripts/ci/report.mjs", root).pathname;
    mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
    const file = path.join(dir, "scripts/ci/config.json");
    writeFileSync(file, JSON.stringify(config));
    writeFileSync(path.join(dir, config.quarantineFile), JSON.stringify([{ class: "flaky", owner: "synthetic owner", suite: "synthetic.spec.ts", expires: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10) }]));
    mkdirSync(path.join(dir, ".cache/ci/e2e-results"), { recursive: true });
    writeFileSync(path.join(dir, ".cache/ci/e2e-results/junit.baseline.json"), JSON.stringify({ baselineReds: [], newReds: [], fixed: [["playwright", "chromium", "fixture", "fixed"]] }));
    const env = { ...process.env, CI_CACHE_TOTAL: "0", CI_STARTED_AT: String(Math.floor(Date.now() / 1000) - 1), CI_STEPS: JSON.stringify({ plan: { outputs: { budget: JSON.stringify({ jobs: 38, minutes: 206, wallMinutes: 195, queueMinutes: 240, perJob: { web: 8 } }) } }, registry: { outputs: { "cache-hit": "false", "cache-matched-key": "older-key" } }, npm: { outputs: { "cache-hit": "true" } } }) };
    assert.equal(spawnSync("node", [script], { cwd: dir, env, encoding: "utf8" }).status, 0);
    const report = JSON.parse(readFileSync(path.join(dir, ".cache/ci/metrics.json"), "utf8"));
    assert.equal(report.cacheHits, 2);
    assert.equal(report.cacheLookups, 2);
    assert.equal(report.fixed, 1);
    const summary = readFileSync(path.join(dir, ".cache/ci/summary.md"), "utf8");
    assert.match(summary, /1 fixed \(remove from baseline\)/);
    assert.ok(summary.includes(`38/${config.maxJobs} jobs, 206/${config.maxTotalMinutes}`));
    assert.match(summary, /timeout chain 195\/240/);
    assert.match(summary, /Predicted per-job minutes:.*"web":8/);
    assert.match(summary, /Flaky quarantine: 1\//);
    assert.match(summary, /Expiry D-7: synthetic owner \/ synthetic.spec.ts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hygiene always runs the hermetic input guard", () => {
  mandatory(workflow().jobs.hygiene.steps.find((step) => step.run === 'node --test --test-name-pattern="check refuses" scripts/check-hermetic.test.mjs'), "hermetic input guard");
});
