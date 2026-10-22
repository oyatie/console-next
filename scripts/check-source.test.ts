// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("component journeys and gallery cache fixtures preserve production source rules", () => {
  const root = mkdtempSync(path.join(tmpdir(), "source-layout-"));
  const slice = "apps/web/src/features/probe/ui/";
  const write = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  try {
    for (const dir of ["packages/api/src", "packages/i18n/src", "e2e"]) mkdirSync(path.join(root, dir), { recursive: true });
    write("oxlint.json", '{"overrides":[]}');
    write(`${slice}grid.spec.ts`, "");
    write(`${slice}grid.playwright.ts`, "");
    write(`${slice}grid.gallery.module.css`, "");
    const seed = "cache.setQueryData(descriptor.queryKey, []);";
    write(`${slice}grid.gallery.tsx`, seed);
    write(`${slice}screen.tsx`, seed);
    write(`${slice}misplaced.ts`, "");
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "check-source.mjs")], { cwd: root, encoding: "utf8" });
    // The minimal tree deliberately omits the repository's inherited import exceptions.
    expect(result.stderr).toContain("stale baseline import");
    for (const file of ["grid.spec.ts", "grid.playwright.ts", "grid.gallery.module.css", "grid.gallery.tsx"]) {
      expect(result.stderr).not.toContain(`${slice}${file}:`);
    }
    expect(result.stderr).toContain(`${slice}screen.tsx: queryKey ×1`);
    expect(result.stderr).toContain(`${slice}screen.tsx: cacheWrites ×1`);
    expect(result.stderr).toContain(`${slice}misplaced.ts: a slice holds only`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
