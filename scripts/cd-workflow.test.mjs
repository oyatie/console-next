// SPDX-License-Identifier: LicenseRef-Proprietary
// node --test scripts/cd-workflow.test.mjs
// The CD workflow's safety properties (console-infra docs/adr-0003-cd-actions-keyless.md):
// every gate runs before anything is published, and a failing gate stops the rollout.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import yaml from "js-yaml";

// Published workflows live under .github/; private checkouts may keep them under .github-public/.
const dir = existsSync(new URL("../.github/workflows/cd.yml", import.meta.url)) ? "../.github/workflows/" : "../.github-public/workflows/";
const file = new URL(`${dir}cd.yml`, import.meta.url);
const text = readFileSync(file, "utf8");
const wf = yaml.load(text);
const probeText = readFileSync(new URL(`${dir}probe.yml`, import.meta.url), "utf8");
const probe = yaml.load(probeText);
const rollout = wf.jobs.rollout;
const tb = (s) => /scripts\/tb (\S+)/.exec(s.run ?? "")?.[1];
const order = rollout.steps.map((s) => tb(s) ?? s.uses?.split("@")[0] ?? s.name);

test("runs only for dev pushes, and only once CD_ENABLED is 'true' (a missing variable is off, CD-4)", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(wf.on.push.branches, ["dev"]);
  assert.match(rollout.if, /github\.event_name == 'push'/);
  assert.match(rollout.if, /github\.ref == 'refs\/heads\/dev'/);
  for (const job of [rollout, wf.jobs.control]) {
    assert.match(job.if, /vars\.CD_ENABLED == 'true'/);
    assert.ok(!/CD_HOLD|!= 'true'/.test(job.if), "opt-in, never opt-out");
  }
  assert.match(wf.jobs.control.if, /github\.ref == 'refs\/heads\/dev'/);
});

test("the owner switches are what the host accepts from a keyless signature: no unfreeze (CD-3)", () => {
  const opts = wf.on.workflow_dispatch.inputs.action.options;
  assert.deepEqual([...opts].sort(), ["canary-abort", "canary-hold", "canary-promote", "freeze", "rollback"]);
});

test("the owner notification links to the run without naming its actor", () => {
  const notify = Object.values(wf.jobs).flatMap((job) => job.steps).find((s) => s.run?.includes("GITHUB_RUN_URL"));
  assert.ok(notify, "owner notification step");
  assert.equal(notify.env.ACTOR, undefined);
  assert.match(notify.run, /Run \$\{GITHUB_RUN_URL\}\./);
  assert.doesNotMatch(notify.run, /Requested by|ACTOR/);
});

test("console-infra is checked out at a pinned full sha, checked before the checkout (CD-5)", () => {
  for (const [name, job] of Object.entries(wf.jobs)) {
    const at = job.steps.findIndex((s) => s.uses?.startsWith("actions/checkout") && s.with?.repository);
    assert.ok(at > 0, `${name}: infra checkout`);
    assert.equal(job.steps[at].with.ref, "${{ vars.CONSOLE_INFRA_REF }}", name);
    const guard = job.steps.slice(0, at).find((s) => /CONSOLE_INFRA_REF/.test(JSON.stringify(s)));
    assert.ok(guard && /\[0-9a-f\]\{40\}/.test(guard.run), `${name}: a step refuses a ref that is not a 40-hex sha`);
  }
});

test("the owner switches never queue behind a rollout", () => {
  assert.equal(wf.concurrency, undefined, "no workflow-level concurrency group");
  assert.equal(rollout.concurrency.group, "cd-rollout");
  assert.equal(rollout.concurrency["cancel-in-progress"], false);
  assert.equal(wf.jobs.control.concurrency, undefined);
});

test("every gate runs, in order, before sign, release and verify", () => {
  const want = ["tools-check", "candidate", "api-compat", "sbom", "scan", "smoke", "sign-candidate", "rehearse", "sign"];
  const at = want.map((g) => order.indexOf(g));
  assert.ok(at.every((i) => i >= 0), `missing gate: ${want.filter((g, k) => at[k] < 0)}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "gates out of order");
  const sign = order.indexOf("sign");
  const release = order.indexOf("release");
  assert.ok(sign < order.indexOf("actions/attest-build-provenance") && sign < release);
  assert.ok(release < order.indexOf("verify"));
});

test("a failing gate stops the rollout: no step outlives a failure but the notice", () => {
  assert.ok(!/continue-on-error/.test(text), "continue-on-error is not allowed");
  for (const [name, job] of Object.entries(wf.jobs)) {
    for (const s of job.steps) {
      if (s.if === undefined) continue;
      assert.ok(tb(s) === "notify", `${name}: only the notify step may carry an if (found on ${s.name ?? s.uses})`);
      // CD-11: a timeout or a cancel is reported too.
      assert.match(s.if, name === "rollout" ? /^failure\(\) \|\| cancelled\(\)$/ : /^always\(\)$/);
    }
  }
  for (const s of rollout.steps.filter((x) => x.run)) assert.ok(!/\|\|\s*true/.test(s.run), `|| true in ${s.name}`);
});

test("signing is keyless and the release is never approved by hand", () => {
  assert.equal(wf.env.COSIGN_KEYLESS, "1");
  assert.ok(!/COSIGN_KEY:|COSIGN_PASSWORD/.test(text), "no signing key in CD");
  assert.equal(rollout.environment, "production");
});

test("supply chain: SHA-pinned actions, least privilege, no pull_request_target", () => {
  assert.deepEqual(wf.permissions, {});
  assert.ok(!/pull_request_target/.test(text));
  for (const [, job] of Object.entries(wf.jobs)) {
    assert.equal(job["runs-on"], "ubuntu-24.04-arm");
    assert.equal(job.permissions.contents, "read");
    for (const p of Object.keys(job.permissions)) assert.ok(["contents", "id-token", "attestations"].includes(p), p);
    for (const s of job.steps.filter((x) => x.uses)) assert.match(s.uses, /@[0-9a-f]{40}$/, s.uses);
    for (const s of job.steps.filter((x) => x.uses?.startsWith("actions/checkout"))) assert.equal(s.with["persist-credentials"], false);
  }
  assert.equal(wf.jobs.control.permissions.attestations, undefined);
});

test("no secret or registry path lands in the public store or an artifact", () => {
  assert.ok(!/upload-artifact/.test(text), "artifacts of a public repo are public");
  const prov = rollout.steps.find((s) => s.uses?.startsWith("actions/attest-build-provenance"));
  assert.equal(prov.with["subject-name"], "console-app");
  assert.equal(prov.with["push-to-registry"], undefined);
  for (const v of ["CONSOLE_OCIR_PREFIX", "CONSOLE_OCIR_USER", "OCI_CONFIG"]) assert.ok(!text.includes(`vars.${v}`), `${v} must be a secret (masked in logs)`);
});

test("the release build is never cached: the image is rebuilt from source every time", () => {
  // console-infra images/console-app.Dockerfile and scripts/verify-repro.sh: a cached
  // artifact must never stand in for source in the signed image.
  for (const s of Object.values(wf.jobs).flatMap((j) => j.steps)) {
    assert.ok(!/^(actions\/cache|Swatinem\/rust-cache|mozilla-actions\/sccache-action)@/.test(s.uses ?? ""), s.uses);
    if (s.uses?.startsWith("actions/setup-")) assert.equal(s.with?.cache, undefined, s.uses);
  }
  assert.ok(!/SCCACHE_|RUSTC_WRAPPER|ACTIONS_CACHE_URL|ACTIONS_RESULTS_URL|cache-from|cache-to/.test(text), "no cache wiring in cd.yml");
});

test("least exposure: egress blocked to an allow-list; ONS topic only in the notify step (CD-7)", () => {
  for (const [name, job] of Object.entries(wf.jobs)) {
    const hr = job.steps[0];
    assert.match(hr.uses ?? "", /^step-security\/harden-runner@/, `${name}: harden-runner first`);
    assert.equal(hr.with["egress-policy"], "block", name);
    assert.ok(hr.with["allowed-endpoints"].includes("fulcio.sigstore.dev:443"), name);
    assert.equal(job.env.ONS_TOPIC_ID, undefined, `${name}: ONS_TOPIC_ID at job level`);
    for (const s of job.steps) if (s.env?.ONS_TOPIC_ID) assert.equal(tb(s), "notify", `${name}: ONS_TOPIC_ID on ${s.name}`);
  }
});

test("the probe notifies as console-ci-notify in its own environment: no deploy key, no OCIR, no infra checkout (B-06, CD-9)", () => {
  assert.ok(!/CONSOLE_INFRA_DEPLOY_KEY|OCIR_|ssh-key|scripts\/tb/.test(probeText));
  const n = probe.jobs.notify;
  assert.equal(n.environment, "probe");
  assert.deepEqual(n.permissions, {});
  const pub = n.steps.find((s) => /ons message publish/.test(s.run ?? ""));
  assert.match(pub.run, /ghcr\.io\/oracle\/oci-cli:[0-9]+@sha256:[0-9a-f]{64}/, "OCI CLI image pinned by digest");
  for (const k of ["OCI_CONFIG", "OCI_API_KEY", "ONS_TOPIC_ID"]) assert.equal(pub.env[k], `\${{ secrets.${k} }}`, k);
  assert.ok(!n.steps.some((s) => s.uses?.startsWith("actions/checkout")), "no checkout in the notify job");
  const get = probe.jobs.probe.steps.find((s) => /PROBE_URL/.test(JSON.stringify(s.env ?? {})));
  assert.match(get.run, /assets/, "the probe also fetches the page's module entry under /assets/ (white screen, 2026-10-08)");
});

test("only the rollout job holds the OCIR push token; every other job pulls as console-ci-pull", () => {
  const wfDir = new URL(dir, import.meta.url);
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const src = readFileSync(new URL(f, wfDir), "utf8");
    const jobs = yaml.load(src).jobs ?? {};
    for (const [name, job] of Object.entries(jobs)) {
      const body = JSON.stringify(job);
      if (f === "cd.yml" && name === "rollout") continue;
      assert.ok(!body.includes("OCIR_PUSH_TOKEN"), `${f} ${name} names OCIR_PUSH_TOKEN`);
      if (body.includes("OCIR_PULL_TOKEN")) {
        assert.equal(job.env.OCIR_PULL_TOKEN, "${{ secrets.OCIR_CI_PULL_TOKEN }}", `${f} ${name}`);
        assert.equal(job.env.CONSOLE_OCIR_USER, "${{ secrets.CONSOLE_OCIR_PULL_USER }}", `${f} ${name}`);
      }
    }
    if (f !== "cd.yml") assert.ok(!src.includes("OCIR_PUSH_TOKEN"), `${f} names OCIR_PUSH_TOKEN (comments included)`);
  }
  assert.equal(rollout.env.OCIR_PUSH_TOKEN, "${{ secrets.OCIR_PUSH_TOKEN }}");
});
