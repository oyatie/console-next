// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test.each(["quality/ratchet.mjs", "check-person-reads.mjs", "check-copy.mjs"])("%s selects a related public/dev over unrelated dev and diagnoses invalid bases", script => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "quality-ref-")));
  const env = { ...process.env };
  delete env.QUALITY_BASE;
  try {
    for (const dir of ["scripts/quality", "backend/app/src", "backend/crates", "apps/web/src", "apps/web/public", "packages/api/src", "packages/i18n/src/catalogs/ko", "packages/i18n/src/catalogs/en"])
      mkdirSync(path.join(root, dir), { recursive: true });
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    for (const file of ["scripts/quality/ratchet.mjs", "scripts/check-person-reads.mjs", "scripts/check-copy.mjs", "packages/i18n/src/josa.ts"])
      copyFileSync(file, path.join(root, file));
    for (const [file, text] of Object.entries({
      ".gitignore": "node_modules/\n",
      "package.json": '{"type":"module"}',
      "scripts/person-reads-baseline.json": "{}",
      "scripts/copy-maturity-baseline.json": "{}",
      "scripts/copy-unused-baseline.json": '{"unused":[]}',
      "scripts/copy-terms-allow.json": '{"allow":[]}',
      "scripts/composer-allow.json": '{"allow":[]}',
    })) writeFileSync(path.join(root, file), text);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Jason Lee", "-c", "user.email=56489493+jason931225@users.noreply.github.com", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-b", "lane");
    git("add", ".");
    git("commit", "-m", "quality fixture");
    git("branch", "dev");
    const run = (ref?: string) => spawnSync(process.execPath, [path.join(root, "scripts", script)], { cwd: root, encoding: "utf8", env: ref === undefined ? env : { ...env, QUALITY_BASE: ref } });
    const fallback = run();
    expect(fallback.status, fallback.stderr).toBe(0);
    git("update-ref", "refs/remotes/public/dev", "HEAD");
    const unrelated = git("commit-tree", "HEAD^{tree}", "-m", "unrelated dev");
    git("update-ref", "refs/heads/dev", unrelated);
    expect(spawnSync("git", ["merge-base", "HEAD", "dev"], { cwd: root }).status).toBe(1);
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
    git("update-ref", "-d", "refs/remotes/public/dev");
    const noAncestor = run();
    expect(noAncestor.status).toBe(1);
    expect(noAncestor.stderr).toContain("cannot resolve quality merge-base between HEAD and dev");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
