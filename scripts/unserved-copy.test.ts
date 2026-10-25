// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const allowPath = "scripts/unserved-copy-allow.json";
type Entry = { locale: string; id: string; text: string };
type Allow = { locale: string; id: string; lane: string; gap: string };
import { roadmap, withoutExceptions } from "./unserved-copy";
const key = (e: { locale: string; id: string }) => `${e.locale}:${e.id}`;

function scan(text: string, locale: string): Entry[] {
  const source = ts.createSourceFile("catalog.ts", text, ts.ScriptTarget.Latest, true);
  const entries: Entry[] = [];
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && ts.isStringLiteralLike(node.initializer) && roadmap.test(node.initializer.text)) {
      entries.push({ locale, id: node.name.text, text: node.initializer.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return entries;
}

function violations(entries: Entry[], allow: Allow[]) {
  const live = new Set(entries.map(key));
  const allowed = new Set(allow.map(key));
  return [
    ...entries.filter((e) => !allowed.has(key(e))).map((e) => `${key(e)}: ${e.text}`),
    ...allow.filter((e) => !live.has(key(e)) || !e.lane || !e.gap).map((e) => `${key(e)}: stale or unowned exception`),
    ...(allowed.size !== allow.length ? ["duplicate exceptions"] : []),
  ];
}

test("catalogs contain no unserved copy beyond owned, live exceptions", () => {
  const entries = ["ko", "en"].flatMap((locale) => {
    const dir = new URL(`packages/i18n/src/catalogs/${locale}/`, root);
    return readdirSync(dir).filter((f) => f.endsWith(".ts")).flatMap((f) => scan(readFileSync(new URL(f, dir), "utf8"), locale));
  });
  const allow = JSON.parse(readFileSync(new URL(allowPath, root), "utf8")) as Allow[];
  expect(violations(entries, allow)).toEqual([]);
});

test("a planted roadmap value and deleting its live exception both fail", () => {
  for (const text of ["아직 열지 않았습니다", "아직 서버에 없습니다", "파일럿 이후", "Not available yet", "Coming later"]) {
    const entries = scan(`export const catalog = { "planted.id": ${JSON.stringify(text)} };`, "ko");
    expect(entries).toHaveLength(1);
    expect(scan(`export const catalog = { "planted.id": \`${text}\` };`, "ko")).toHaveLength(1);
    expect(violations(entries, [])).toHaveLength(1);
    const allow = [{ locale: "ko", id: "planted.id", lane: "fixture", gap: "fixture" }];
    expect(violations(entries, allow)).toEqual([]);
    expect(violations([], allow)).toHaveLength(1);
  }
});

test("the committed exception list only shrinks", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const base = git("merge-base", "HEAD", process.env.QUALITY_BASE ?? "dev");
  const exists = git("ls-tree", "--name-only", base, "--", allowPath);
  // On first introduction the seed commit owns the ceiling; later dev carries it.
  const seed = exists ? base : git("log", "--reverse", "--diff-filter=A", "--format=%H", "HEAD", "--", allowPath).split("\n")[0];
  if (!seed) return;
  const previous = JSON.parse(git("show", `${seed}:${allowPath}`)) as Allow[];
  const current = JSON.parse(readFileSync(new URL(allowPath, root), "utf8")) as Allow[];
  expect(current.filter((entry) => !previous.some((old) => key(old) === key(entry)))).toEqual([]);
});


test("browser exceptions remove exact owned copy without hiding a new roadmap sentence", () => {
  const owned = "이 항목은 아직 확인 기록을 받지 않습니다";
  expect(withoutExceptions(`${owned} ${owned}`, [owned])).not.toMatch(roadmap);
  expect(withoutExceptions(`${owned} 다른 기능은 아직 열지 않았습니다`, [owned])).toMatch(roadmap);
});
