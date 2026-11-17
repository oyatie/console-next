// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

test.each(["features/home/Home.tsx", "features/home/ui/home.tsx", "features/home/api.ts", "features/home/domain/home.ts"])("%s cannot import the experience table", file => {
  const root = mkdtempSync(path.join(tmpdir(), "experience-boundary-"));
  const fixture = path.join(root, "apps/web/src", file);
  try {
    mkdirSync(path.dirname(fixture), { recursive: true });
    writeFileSync(path.join(root, "oxlint.json"), readFileSync("oxlint.json"));
    writeFileSync(fixture, 'import { experiences } from "../../../experience/table";\nexport const count = experiences.length;\n');
    const result = spawnSync(path.resolve("node_modules/.bin/oxlint"), ["-c", "oxlint.json", path.relative(root, fixture)], { cwd: root, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Features never read the experience");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
