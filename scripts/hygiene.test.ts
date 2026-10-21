// Repo hygiene gates (security baseline rows 1 and 17.11), run by `npm test` inside `npm run check`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// Git refuses paths beneath a real symlink; test the ignore rules independently of worktree dependencies.
const ignoreStatus = (p: string) => {
  const dir = mkdtempSync(path.join(root, ".hygiene-"));
  try {
    writeFileSync(path.join(dir, ".gitignore"), readFileSync(path.join(root, ".gitignore")));
    expect(spawnSync("git", ["init", "--quiet", dir]).status).toBe(0);
    return spawnSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: dir }).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

// Commit 6a5357f4 committed 11,814 files of node_modules.old-structpair/ because `node_modules` did not match it.
test.each(["node_modules.old-structpair/x/package.json", "apps/web/node_modules.bak/y.js", "node_modules/z.js", "packages/api/node_modules/q"])(
  ".gitignore keeps %s out of git",
  (p) => {
    expect(ignoreStatus(p), `${p} is not ignored`).toBe(0);
  },
);

test("the ignore rules keep application source visible to Git", () => {
  expect(ignoreStatus("apps/web/src/example.ts")).toBe(1);
});

const gitleaks = (body: string, config: string[] = ["--config", path.join(root, ".gitleaks.toml")]) => {
  const dir = mkdtempSync(path.join(tmpdir(), "gitleaks-canary-"));
  try {
    writeFileSync(path.join(dir, "chunk.js"), body);
    return spawnSync("gitleaks", ["dir", "--no-banner", "--redact", ...config, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const b62 = (n: number) => [...randomBytes(n)].map((x) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[x % 62]).join("");

// The canary is built at runtime so this file holds no token-shaped literal.
test("the repo gitleaks config still catches a planted token (not an empty rule set)", () => {
  const r = gitleaks(`const t = "${"ghp_" + b62(36)}";\n`);
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
});

// Vite's CSS-module class map (`_<class>_<hash>_<line>`): the default generic-api-key rule flags it.
const cssModuleMap = 'var s={keyRow:"_keyRow_1x9qz_42",x:1};\n';
test("a CSS-module class map entry trips the default rules but not the repo allowlist", () => {
  expect(gitleaks(cssModuleMap, []).status).toBe(1);
  const r = gitleaks(cssModuleMap);
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
});
