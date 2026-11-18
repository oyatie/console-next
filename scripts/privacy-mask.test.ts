// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitFixtureEnvironment } from "./lib/git-fixture-environment.mjs";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";
import { atBase, baselineGrowth, qualityRef } from "./quality/ratchet.mjs";

function literals(text: string) {
  const source = ts.createSourceFile("mask.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) && /[•●]|^\*+$|[\d-]\*{2,}/.test(node.text)) count++;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}

const file = "scripts/privacy-mask-baseline.json";
const baseline = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;

function assertBaseline(current: Record<string, number>, root = process.cwd()) {
  const original = atBase(root, qualityRef(root), file);
  if (original) expect(baselineGrowth(current, JSON.parse(original))).toEqual([]);
}

test("new display mask literals stay in the card mask module; inherited exceptions only shrink", () => {
  const found = Object.fromEntries(files("apps/web/src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.(test|spec|playwright|gallery)\./.test(f) && !f.endsWith("people/domain/card.ts"))
    .map((f) => [f, literals(readFileSync(f, "utf8"))] as const).filter(([, n]) => n));
  expect(found).toEqual(Object.fromEntries(Object.entries(baseline).filter(([f]) => f.startsWith("apps/"))));
  assertBaseline(baseline);
});

test("the mask ratchet catches literals and template fragments, including legacy glyphs", () => {
  expect(literals('const rrn="••••••-•••••••"; const birth=`${year}-●●`; const old="010-****-1234"; const single="*".repeat(4);')).toBe(4);
  expect(literals('const glob="**/api/**"; // •••• in a comment')).toBe(0);
});

test("server display masks are centralized; the legacy storage mask stays storage-only", () => {
  const found: Record<string, number> = {};
  for (const file of files("backend/crates/hr").filter((f) => f.endsWith(".rs") && !/\/tests\/|_tests\.rs$/.test(f) && !f.endsWith("profile/mask.rs"))) {
    let source = readFileSync(file, "utf8").split("#[cfg(test)]")[0]!.replace(/\/\/[^\n]*/g, "");
    if (file.endsWith("import/rrn_value.rs")) source = source.replace('"{}-{}******"', '"storage"');
    const count = source.match(/"[^"\n]*\*{2,}[^"\n]*"/g)?.length ?? 0;
    if (count) found[file] = count;
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(baseline).filter(([f]) => f.startsWith("backend/"))));
  const status = readFileSync("backend/crates/hr/adapter-postgres/src/rrn/mod.rs", "utf8");
  expect(status).toContain("mask::rrn(");
  expect(status).not.toContain("masked: row.as_ref().map(|r| r.0.clone())");
});

test("mask baseline growth is refused against dev's upstream when local dev has no baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "mask-baseline-"));
  const env = gitFixtureEnvironment();
  delete env.QUALITY_BASE;
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, env, stdio: "pipe" });
  const override = process.env.QUALITY_BASE;
  delete process.env.QUALITY_BASE;
  try {
    git("init", "-b", "dev");
    git("commit", "--allow-empty", "-m", "test: seed local dev");
    git("switch", "-c", "topic");
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, file), JSON.stringify({ fixture: 1 }));
    git("add", ".");
    git("commit", "-m", "test: seed upstream masks");
    git("remote", "add", "team", "https://example.invalid/console.git");
    git("update-ref", "refs/remotes/team/dev", "HEAD");
    git("branch", "--set-upstream-to=team/dev", "dev");
    expect(() => assertBaseline({ fixture: 1 }, root)).not.toThrow();
    writeFileSync(join(root, file), "{}");
    git("add", ".");
    git("commit", "-m", "test: remove upstream masks");
    git("update-ref", "refs/remotes/team/dev", "HEAD");
    expect(() => assertBaseline({ fixture: 1 }, root)).toThrow();
  } finally {
    if (override === undefined) delete process.env.QUALITY_BASE;
    else process.env.QUALITY_BASE = override;
    rmSync(root, { recursive: true, force: true });
  }
});
