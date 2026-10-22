// SPDX-License-Identifier: LicenseRef-Proprietary
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { project, sourceFiles } from "./quality/project.mjs";

test("quality refuses an empty source set before constructing a TypeScript program", () => {
  const root = mkdtempSync(join(tmpdir(), "quality-empty-"));
  try {
    mkdirSync(join(root, "src"));
    expect(() => sourceFiles(root, ["src"])).toThrow(/no.*source/i);
    writeFileSync(join(root, "src/generated.d.ts"), "export declare const value: string;\n");
    expect(() => sourceFiles(root, ["src"])).toThrow(/no.*source/i);
    for (const dir of ["apps", "packages"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { noLib: true }, files: ["src/main.ts"] }));
    expect(() => project(root, [])).toThrow(/no.*source/i);
    writeFileSync(join(root, "src/main.ts"), "export const value = 1;\n");
    expect(sourceFiles(root, ["src"])).toEqual(["src/main.ts"]);
    expect(project(root, ["src/main.ts"]).sources).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
