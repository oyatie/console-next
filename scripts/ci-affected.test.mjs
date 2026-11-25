// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./ci-affected.mjs", import.meta.url));
const backend = { backend: true, web: false };
const web = { backend: false, web: true };
const both = { backend: true, web: true };

for (const [name, files, expected] of [
  ["backend", ["backend/app/src/main.rs", "backend/Cargo.lock"], backend],
  ["root Rust inputs", ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"], backend],
  ["migration and API inputs", ["migrations/change.sql", "openapi.yaml", "openapi/schema.json"], backend],
  ["web", ["apps/web/src/main.tsx", "packages/api/src/schema.d.ts", "e2e/home.spec.ts", "package.json", "package-lock.json"], web],
  ["CI and tooling", [".github/workflows/ci.yml", "scripts/check.mjs"], both],
  ["documentation", ["README.md", "CONTRIBUTING.md", "docs/apps/x.md", "docs/new.md", "docs/design-system-tools/page.md"], both],
  ["web documentation", ["docs/design-system/components/button.md", "docs/quality/dependency-owner-summary.md", "docs/security/code-scanning-triage.md", "docs/testing/e2e.md", "docs/engineering.md", "docs/adr/tooling-convention-linter.md"], web],
  ["unknown", ["new-area/source.txt", ".cargo/config.toml", "tsconfig.json", "deploy/backend/x.rs"], both],
  ["import catalogue labels", ["packages/i18n/src/catalogs/ko/import.ts", "packages/i18n/src/catalogs/en/import.ts"], both],
  ["import catalogue data", ["backend/crates/hr/domain/data/employee.json"], backend],
  ["shared backend contracts", ["backend/openapi/openapi.yaml", "backend/openapi/ops.yaml", "backend/openapi/schemas/Example.yaml"], both],
]) {
  test(`classifies each ${name} path`, async () => {
    const { classifyPaths } = await import("./ci-affected.mjs");
    for (const file of files) assert.deepEqual(classifyPaths([file]), expected, file);
  });
}

test("combines classes and leaves an empty diff unaffected", async () => {
  const { classifyPaths } = await import("./ci-affected.mjs");
  assert.deepEqual(classifyPaths(["backend/app.rs", "apps/web/index.ts"]), both);
  assert.deepEqual(classifyPaths([]), { backend: false, web: false });
});

test("each tracked document reaches the checks that reference it", async () => {
  const { classifyPaths } = await import("./ci-affected.mjs");
  const root = path.dirname(path.dirname(script));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const docs = git("ls-files", "-z", "--", "docs").split("\0").filter(Boolean);
  assert.ok(docs.length);
  const readers = git("grep", "-Ilz", "-e", "docs", "--", "backend", "scripts", "apps", "packages", "e2e", ".github",
    ":(exclude)*.md", ":(exclude)scripts/ci-affected.mjs", ":(exclude)scripts/ci-affected.test.mjs").split("\0").filter(Boolean);
  // Shared scripts can also run in the Rust jobs. Follow their repo paths and relative imports.
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const backendScripts = new Set();
  function followScripts(source, directory) {
    for (const [, ref] of source.matchAll(/(?:^|[^\w-])((?:scripts\/|\.{1,2}\/)[\w./-]+\.(?:mjs|cjs|js|sh|py))\b/gm)) {
      const file = ref.startsWith("scripts/") ? ref : path.join(directory, ref);
      if (!file.startsWith("scripts/") || backendScripts.has(file) || !existsSync(path.join(root, file))) continue;
      backendScripts.add(file);
      followScripts(readFileSync(path.join(root, file), "utf8"), path.dirname(file));
    }
  }
  for (const block of workflow.split(/(?=^  [\w-]+:\s*$)/m)) {
    if (/^  (?:backend[\w-]*|home):/.test(block)) followScripts(block, ".");
  }

  const covered = new Map(docs.map(doc => [doc, new Set()]));
  for (const file of readers) {
    const source = readFileSync(path.join(root, file), "utf8").replace(/^\s*(?:\/\/|\*|# |-- ).*$/gm, "");
    // Also recognize path.join("docs", ...), Rust .join chains and Python path division.
    const joined = source.replace(/(["']docs)((?:["']\s*(?:,|\/|\)\s*\.join\()\s*["'][\w./-]+)+)/g,
      (_, start, tail) => start + tail.replace(/["']\s*(?:,|\/|\)\s*\.join\()\s*["']/g, "/"));
    const prefixes = new Set();
    for (const [, prefix] of (source + "\n" + joined).matchAll(/(?<![\w/-])(?:\/?(?:\.\.\/)+|\/)?(docs\/[\w./-]*)/g)) {
      prefixes.add(prefix.replace(/\/$/, ""));
    }
    if (/(?:join|resolve|read_dir|readdirSync|Path)\([^()]*["']docs["']\s*[,)]/.test(joined)) prefixes.add("docs");
    for (const [doc, files] of covered) {
      if ([...prefixes].some(prefix => doc === prefix || doc.startsWith(prefix + "/") || doc.startsWith(prefix + "."))) files.add(file);
    }
  }
  for (const [doc, files] of covered) {
    const route = classifyPaths([doc]);
    assert.ok(route.web, `${doc}: repository-wide web source and secrets checks`);
    // A live browser reader needs a backend build. Treat shared workflows conservatively.
    const backendReader = [...files].find(file => /^(?:backend|\.github|e2e)\//.test(file) || backendScripts.has(file));
    if (backendReader) assert.ok(route.backend, `${doc}: reader ${backendReader} requires backend`);
    else if (files.has("scripts/ds-docs.mjs")) assert.deepEqual(route, web, doc);
  }
  assert.ok([...covered.values()].some(files => files.has("scripts/ds-docs.mjs")), "no design-system reader found");
});

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-affected-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Jason Lee", GIT_AUTHOR_EMAIL: "56489493+jason931225@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Jason Lee", GIT_COMMITTER_EMAIL: "56489493+jason931225@users.noreply.github.com" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const write = (file, text = "fixture\n") => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const commit = () => {
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "test: affected paths fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=dev");
  write("README.md");
  const base = commit();
  const run = (event = "pull_request", from = base, head = git("rev-parse", "HEAD")) => {
    const output = path.join(root, ".git", "output");
    const summary = path.join(root, ".git", "summary");
    writeFileSync(summary, "");
    writeFileSync(output, "");
    const result = spawnSync(process.execPath, [script, event, from, head], {
      cwd: root, env: { ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, encoding: "utf8",
    });
    return { ...result, output: readFileSync(output, "utf8"), summary: readFileSync(summary, "utf8") };
  };
  return { root, git, write, commit, base, run };
}

test("PR and merge queue classify the candidate against the merge base, excluding later base-only changes", (t) => {
  const f = fixture(t);
  f.git("checkout", "-qb", "candidate");
  f.write("apps/web/page.tsx");
  const head = f.commit();
  f.git("checkout", "-q", "dev");
  f.write("backend/base-only.rs");
  const base = f.commit();
  for (const event of ["pull_request", "merge_group"]) {
    const result = f.run(event, base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "backend=false\nweb=true\ndocs=none\nlockfile=false\n");
  }
});

for (const event of ["pull_request", "merge_group"]) {
  test(`${event} requests signature verification only for changes to the root npm lockfile`, t => {
    const f = fixture(t);
    f.write("package-lock.json");
    f.write("apps/web/package.json");
    f.write("package.json");
    const base = f.commit();
    f.write("nested/package-lock.json");
    f.write("package.json", "manifest only");
    const unchanged = f.run(event, base, f.commit());
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.output, /^lockfile=false$/m);
    const reason = `Skipping npm signature verification: package-lock.json unchanged against ${base}`;
    assert.ok(unchanged.stdout.split("\n").includes(reason));
    assert.equal(unchanged.summary, reason + "\n");

    f.write("apps/web/package.json", "workspace dependency bump");
    f.write("package-lock.json", "updated dependency");
    f.write("package.json", "root dependency bump");
    const changed = f.run(event, base, f.commit());
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.output, /^lockfile=true$/m);
    assert.doesNotMatch(changed.stdout, /Skipping npm signature verification/);
    assert.equal(changed.summary, "");
  });
}

for (const [before, after] of [
  ["backend/renamed.rs", "apps/web/renamed.ts"],
  ["apps/web/renamed.ts", "backend/renamed.rs"],
  ["apps/web/renamed.ts", "unclassified/renamed.ts"],
]) {
  test(`rename from ${before} to ${after} affects both classes`, (t) => {
    const f = fixture(t);
    f.write(before);
    const base = f.commit();
    f.write(after);
    f.git("rm", "-q", before);
    const head = f.commit();
    assert.match(f.git("diff", "--name-status", "--find-renames", base, head), /^R100/);
    const result = f.run("pull_request", base, head);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "backend=true\nweb=true\ndocs=none\nlockfile=false\n");
  });
}

test("deleted paths and filenames containing tabs and newlines stay in the diff", (t) => {
  const f = fixture(t);
  f.write("backend/deleted.rs");
  const base = f.commit();
  f.git("rm", "-q", "backend/deleted.rs");
  f.write("apps/web/tab\tand\nnewline.ts");
  const result = f.run("merge_group", base, f.commit());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "backend=true\nweb=true\ndocs=none\nlockfile=false\n");
});

test("push always affects both classes without needing a base revision", (t) => {
  const result = fixture(t).run("push", "", "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "backend=true\nweb=true\ndocs=none\nlockfile=true\n");
});

test("unsupported events fail without publishing outputs", (t) => {
  const result = fixture(t).run("workflow_dispatch");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CI_AFFECTED_EVENT/);
  assert.equal(result.output, "");
});

test("missing or malformed revisions fail without publishing outputs", (t) => {
  const f = fixture(t);
  for (const [base, head] of [["", f.base], [f.base, ""], ["--help", f.base], [f.base, "HEAD"]]) {
    const result = f.run("pull_request", base, head);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CI_AFFECTED_SHA/);
    assert.equal(result.output, "");
  }
});

test("unavailable commits fail without publishing outputs", (t) => {
  const f = fixture(t);
  const result = f.run("merge_group", "0".repeat(40), f.base);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Command failed: git merge-base/);
  assert.equal(result.output, "");
});

test("the PR output distinguishes docs alone from docs mixed with application changes", t => {
  const f = fixture(t);
  f.write("docs/design-system/components/button.md");
  f.commit();
  assert.equal(f.run().output, "backend=false\nweb=true\ndocs=only\nlockfile=false\n");
  f.write("apps/web/page.tsx");
  f.commit();
  assert.equal(f.run().output, "backend=false\nweb=true\ndocs=mixed\nlockfile=false\n");
});
