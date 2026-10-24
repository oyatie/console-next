// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";
import { endpointProblems } from "./ci/egress.mjs";
import { affected, requiredJobs } from "./ci/plan.mjs";
import { releasePackages } from "./check-reach.mjs";

const workflows = () => readdirSync(".github/workflows").filter((file) => /\.ya?ml$/.test(file))
  .map((file) => [file, load(readFileSync(`.github/workflows/${file}`, "utf8"))]);

test("every checkout job allows GitHub HTTPS; removing it is refused", () => {
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job.steps.some((step) => step.uses?.startsWith("actions/checkout@"))) continue;
    const input = job.steps.find((step) => step.with?.["egress-policy"] === "block").with;
    assert.ok(input["allowed-endpoints"].split(" ").includes("github.com:443"), `${file}:${name}`);
    input["allowed-endpoints"] = input["allowed-endpoints"].split(" ").filter((endpoint) => endpoint !== "github.com:443").join(" ");
    assert.ok(endpointProblems(job).missing.includes("github.com:443"), `${file}:${name}: missing checkout access accepted`);
  }
});

test("every block-mode job has a nonempty allow-list", () => {
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) if (step.with?.["egress-policy"] === "block") {
      assert.ok(step.with["allowed-endpoints"]?.trim(), `${file}:${name}: empty block allow-list`);
    }
  }
});

test("checked-in egress inputs are generated literal per-job contracts", () => {
  for (const [file, workflow] of workflows()) {
    const source = readFileSync(`.github/workflows/${file}`, "utf8");
    const hardened = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.with?.["egress-policy"] === "block"));
    assert.equal([...source.matchAll(/^      - uses: step-security\/harden-runner@/gm)].length, hardened.length, `${file}: hardening action must be literal per job`);
    for (const step of hardened) assert.ok(source.includes(`allowed-endpoints: ${JSON.stringify(step.with["allowed-endpoints"])}`), `${file}: pre-step input must be a literal single line`);
  }
  const result = spawnSync("node", ["scripts/ci/generate-egress.mjs", "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("egress generation repairs missing checkout access and refuses empty or aliased block jobs", async () => {
  const { generateEgress } = await import("./ci/generate-egress.mjs");
  const source = `jobs:
  proof:
    steps:
      - uses: step-security/harden-runner@pin
        with:
          egress-policy: block
          allowed-endpoints: ''
      - uses: actions/checkout@pin
`;
  const generated = generateEgress(source);
  assert.equal(load(generated).jobs.proof.steps[0].with["allowed-endpoints"], "api.github.com:443 codeload.github.com:443 github.com:443");
  assert.equal(generateEgress(generated), generated);
  const restricted = generateEgress(source.replace("egress-policy: block", "egress-policy: block\n          disable-sudo: true"));
  assert.equal(load(restricted).jobs.proof.steps[0].with["disable-sudo"], true);
  assert.throws(() => generateEgress(source.replace("      - uses: actions/checkout@pin\n", "")), /empty block allow-list/);
  assert.throws(() => generateEgress(source.replace("  proof:", "  proof: &proof") + "  alias: *proof\n"), /explicit per-job step/);
  assert.throws(() => generateEgress(source.replace("egress-policy: block", "egress-policy: audit")), /expected block-mode/);
  const another = source.slice(source.indexOf("  proof:")).replace("proof:", "other:").replace("runner@pin", "runner@other");
  assert.throws(() => generateEgress(source + another), /inconsistent harden-runner pins/);
});

test("desktop tests run as required affected proof on PRs, queue entries and releases", () => {
  const workflow = workflows().find(([file]) => file === "ci.yml")[1];
  const job = workflow.jobs["desktop-test"];
  assert.ok(job, "missing desktop crate test job");
  assert.equal(job.if, "needs.plan.outputs.desktop == 'true'");
  assert.ok(job.steps.some((step) => step.run === "npm run desktop:test -- --locked" && !step.if && !step["continue-on-error"]));
  assert.ok(workflow.jobs["ci-ok"].needs.includes("desktop-test"));
  assert.equal(workflow.jobs.plan.outputs.desktop, "${{ steps.plan.outputs.desktop }}");
  const plan = affected(["apps/desktop/src-tauri/src/config.rs"], [], [], "/repo");
  assert.equal(plan.desktop, true);
  assert.equal(plan.backend, false);
  assert.equal(plan.e2e, false);
  assert.equal(requiredJobs(plan)["desktop-test"], true);
  assert.equal(requiredJobs(affected(["docs/ci.md"], [], [], "/repo"))["desktop-test"], false);
  assert.equal(requiredJobs(affected([], [], [], "/repo", true))["desktop-test"], true);
});

test("root reach CLI passes without Rust, an orchestra queue or a local pointer", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "console-reach-no-rust-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const tool of ["cargo", "rustc", "rustup"]) writeFileSync(path.join(dir, tool), "#!/bin/sh\necho 'unexpected Rust invocation' >&2\nexit 97\n", { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, XDG_CONFIG_HOME: "/nonexistent/console-ci-config" };
  delete env.BACKLOG_QUEUE_DIR;
  const result = spawnSync("node", ["scripts/check-reach.mjs"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
});

test("reach metadata follows manifest features, inherited aliases and implicit path members", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "console-reach-manifests-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = {
    "Cargo.toml": '[workspace]\nmembers = ["app"]\n[workspace.dependencies]\nrest = { package = "release-rest", path = "rest" }\n',
    "app/Cargo.toml": '[package]\nname = "app"\n[features]\ndefault = ["mvp"]\nmvp = ["dep:rest"]\n[dependencies]\nrest = { workspace = true, optional = true }\nfuture = { path = "../future", optional = true }\n[dev-dependencies]\ntest-only = { path = "../test-only" }\n',
    "rest/Cargo.toml": '[package]\nname = "release-rest"\n',
    "future/Cargo.toml": '[package]\nname = "future"\n',
    "test-only/Cargo.toml": '[package]\nname = "test-only"\n',
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), source);
  }
  const result = spawnSync("python3", ["scripts/reach-metadata.py", dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const { packages } = JSON.parse(result.stdout);
  assert.deepEqual(packages.map((pkg) => pkg.name), ["app", "future", "release-rest", "test-only"]);
  assert.deepEqual([...releasePackages(packages[0])], ["release-rest"]);
  writeFileSync(path.join(dir, "Cargo.toml"), "invalid [ TOML");
  assert.notEqual(spawnSync("python3", ["scripts/reach-metadata.py", dir], { encoding: "utf8" }).status, 0);
});
