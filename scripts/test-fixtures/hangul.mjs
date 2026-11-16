// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { koCommon } from "../../packages/i18n/src/catalogs/ko/common.ts";

export const ko = koCommon["common.closeRelated"].slice(0, 2);
export function fixture(t, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "hangul-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  for (const file of ["check-hangul.mjs", "quality/base.mjs"]) {
    mkdirSync(path.dirname(path.join(root, "scripts", file)), { recursive: true });
    copyFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(root, "scripts", file));
  }
  write("scripts/copy-hangul-baseline.json", '{"allow":[]}');
  write("rustfmt.toml", 'edition = "2024"\n');
  for (const [file, text] of Object.entries(files)) write(file, text);
  const git = (...args) => execFileSync("git", ["-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  const commit = () => { git("add", "."); git("commit", "-qm", "test: copy fixture"); };
  git("init", "-qb", "dev");
  commit();
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  git("checkout", "-qb", "candidate");
  const run = (...args) => spawnSync(process.execPath, ["scripts/check-hangul.mjs", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, QUALITY_BASE: "origin/dev" } });
  const allow = entries => write("scripts/copy-hangul-baseline.json", JSON.stringify({ allow: entries }));
  return { root, write, git, commit, run, allow };
}
