// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { gitFixtureEnvironment } from "./lib/git-fixture-environment.mjs";

test.each([
  { name: "explicit override", override: "review-base", upstream: true, origin: true, expected: "review-base" },
  { name: "invalid explicit override", override: "missing-ref", upstream: true, origin: true, expected: "missing-ref" },
  { name: "empty override uses the default", override: "", upstream: true, origin: true, expected: "team/trunk" },
  { name: "configured dev upstream", upstream: true, origin: true, expected: "team/trunk" },
  { name: "origin without an upstream", origin: true, expected: "origin/dev" },
  { name: "origin with a missing upstream", missingUpstream: true, origin: true, expected: "origin/dev" },
  { name: "origin without local dev", noDev: true, origin: true, expected: "origin/dev" },
  { name: "local dev fallback", expected: "dev" },
  { name: "leftover origin/dev without an origin remote is ignored", leftoverOrigin: true, expected: "dev" },
])("quality base preference: $name", scenario => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "quality-order-")));
  const env = gitFixtureEnvironment();
  delete env.QUALITY_BASE;
  if ("override" in scenario) env.QUALITY_BASE = scenario.override;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", env });
    git("init", "-b", "topic");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "test: seed quality refs");
    if (!("noDev" in scenario)) git("branch", "dev");
    // An unrelated conventional remote must never outrank the configured upstream or origin.
    git("update-ref", "refs/remotes/public/dev", "HEAD");
    if ("origin" in scenario) git("remote", "add", "origin", "https://example.invalid/console.git");
    if ("origin" in scenario || "leftoverOrigin" in scenario) git("update-ref", "refs/remotes/origin/dev", "HEAD");
    if ("upstream" in scenario || "missingUpstream" in scenario) {
      git("remote", "add", "team", "https://example.invalid/console.git");
      git("update-ref", "refs/remotes/team/trunk", "HEAD");
      git("branch", "--set-upstream-to=team/trunk", "dev");
      if ("missingUpstream" in scenario) git("update-ref", "-d", "refs/remotes/team/trunk");
    }
    const module = pathToFileURL(path.resolve("scripts/quality/base.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { qualityRef } from ${JSON.stringify(module)}; console.log(JSON.stringify(qualityRef(process.argv[1])));`, root], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(scenario.expected);
    const fallback = !("override" in scenario) && !("upstream" in scenario);
    expect(result.stderr).toBe(fallback ? `quality base: ${scenario.expected} (dev has no upstream; set one with git branch --set-upstream-to=<remote>/dev dev, or QUALITY_BASE=<ref>)\n` : "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each(["check-standing-text.mjs", "check-license-headers.mjs", "check-ai-quality.mjs"])("%s uses the remote base and preserves explicit overrides", script => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "quality-cli-")));
  const env = gitFixtureEnvironment();
  delete env.QUALITY_BASE;
  try {
    for (const dir of ["scripts/quality", "docs/quality", "apps/web/src", "packages/api/src", "packages/i18n/src", "e2e"]) mkdirSync(path.join(root, dir), { recursive: true });
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    for (const file of [script, "standing-text-registry.mjs", "check-deps.mjs", ...readdirSync("scripts/quality").filter(f => f.endsWith(".mjs")).map(f => `quality/${f}`)])
      copyFileSync(`scripts/${file}`, path.join(root, "scripts", file));
    const put = (file: string, text: string) => writeFileSync(path.join(root, file), text);
    put(".gitignore", "node_modules\n");
    put("package.json", '{"type":"module","workspaces":["apps/*","packages/*"]}');
    put("package-lock.json", '{"packages":{}}');
    put("tsconfig.json", '{"compilerOptions":{"noLib":true},"include":["apps"]}');
    put("scripts/standing-text-baseline.json", "invalid JSON");
    put("scripts/standing-text-new-screens.json", "{}");
    put("scripts/quality/baseline.json", "invalid JSON");
    put("scripts/quality/dependency-verification.json", "{}");
    put("docs/quality/dependency-register.json", '{"rows":[]}');
    put("apps/web/src/main.tsx", "export {};\n");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, stdio: "pipe", env });
    const commit = () => { git("add", "."); git("commit", "-m", "test: seed quality baseline"); };
    git("init", "-b", "dev");
    commit();
    git("switch", "-c", "topic");
    put("scripts/standing-text-baseline.json", "{}");
    put("scripts/quality/baseline.json", "{}");
    put("inherited.ts", "export {};\n");
    commit();
    git("remote", "add", "origin", "https://example.invalid/console.git");
    git("update-ref", "refs/remotes/origin/dev", "HEAD");
    const run = (overrides = {}, args: string[] = []) => spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], { cwd: root, encoding: "utf8", env: { ...env, ...overrides } });
    const preferred = run();
    expect(preferred.status, preferred.stderr).toBe(0);
    expect(run({ QUALITY_BASE: "" }).status).toBe(0);
    expect(run({ QUALITY_BASE: "missing-ref" }).status).toBe(1);
    if (script !== "check-standing-text.mjs") {
      const args = script === "check-ai-quality.mjs" ? ["--base", "origin/dev"] : ["origin/dev"];
      expect(run({ QUALITY_BASE: "missing-ref" }, args).status).toBe(0);
    } else {
      put("apps/web/src/main.tsx", 'lazyRouteComponent(() => import("./screen"), "Screen");');
      put("apps/web/src/screen.tsx", 'export const Screen = () => <p>{message}</p>;');
      put("scripts/standing-text-baseline.json", JSON.stringify({ "apps/web/src/screen.tsx#Screen": 1 }));
      for (const overrides of [{}, { QUALITY_BASE: "" }]) {
        const raised = run(overrides);
        expect(raised.status, raised.stdout + raised.stderr).toBe(1);
        expect(raised.stderr).toContain("standing-text baseline may only go down");
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test.each(["quality/ratchet.mjs", "check-person-reads.mjs", "check-copy.mjs", "check-hangul.mjs"])("%s selects dev's upstream over unrelated dev and diagnoses invalid bases", script => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "quality-ref-")));
  const env = gitFixtureEnvironment();
  delete env.QUALITY_BASE;
  try {
    for (const dir of ["scripts/quality", "backend/app/src", "backend/crates", "apps/web/src", "apps/web/public", "packages/api/src", "packages/i18n/src/catalogs/ko", "packages/i18n/src/catalogs/en"])
      mkdirSync(path.join(root, dir), { recursive: true });
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    for (const file of ["scripts/quality/base.mjs", "scripts/check-hangul.mjs", "scripts/quality/ratchet.mjs", "scripts/check-person-reads.mjs", "scripts/check-copy.mjs", "packages/i18n/src/josa.ts"])
      copyFileSync(file, path.join(root, file));
    for (const [file, text] of Object.entries({
      ".gitignore": "node_modules\n",
      "package.json": '{"type":"module"}',
      "scripts/person-reads-baseline.json": "{}",
      "scripts/copy-maturity-baseline.json": "{}",
      "scripts/copy-unused-baseline.json": '{"unused":[]}',
      "scripts/copy-terms-allow.json": '{"allow":[]}',
      "scripts/composer-allow.json": '{"allow":[]}',
    })) writeFileSync(path.join(root, file), text);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8", stdio: "pipe", env }).trim();
    git("init", "-b", "lane");
    git("add", ".");
    writeFileSync(path.join(root, "scripts/copy-hangul-baseline.json"), JSON.stringify({ allow: [] }));
    git("add", ".");
    git("commit", "-m", "quality fixture");
    git("branch", "dev");
    const run = (ref?: string) => spawnSync(process.execPath, [path.join(root, "scripts", script)], { cwd: root, encoding: "utf8", env: ref === undefined ? env : { ...env, QUALITY_BASE: ref } });
    const fallback = run();
    expect(fallback.status, fallback.stderr).toBe(0);
    git("update-ref", "refs/remotes/public/dev", "HEAD");
    git("remote", "add", "public", "https://example.invalid/console.git");
    git("branch", "--set-upstream-to=public/dev", "dev");
    const unrelated = git("commit-tree", "HEAD^{tree}", "-m", "unrelated dev");
    git("update-ref", "refs/heads/dev", unrelated);
    expect(spawnSync("git", ["merge-base", "HEAD", "dev"], { cwd: root, env }).status).toBe(1);
    const preferred = run();
    expect(preferred.status, preferred.stderr).toBe(0);
    // An explicit override must still win over the available remote ref.
    for (const ref of ["dev", "missing-ref"]) {
      const invalid = run(ref);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain(`cannot resolve quality merge-base between HEAD and ${ref}`);
    }
    const override = run("lane");
    expect(override.status, override.stderr).toBe(0);
    git("remote", "add", "origin", "https://example.invalid/console.git");
    git("update-ref", "refs/remotes/origin/dev", "lane");
    git("update-ref", "-d", "refs/remotes/public/dev");
    const origin = run();
    expect(origin.status, origin.stderr).toBe(0);
    git("update-ref", "-d", "refs/remotes/origin/dev");
    const noAncestor = run();
    expect(noAncestor.status).toBe(1);
    expect(noAncestor.stderr).toContain("cannot resolve quality merge-base between HEAD and dev");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
