// Planted negative controls for the client contract gate (scripts/check-api-schema.mjs), on a
// throwaway backend repo so the test needs no real backend tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { checkApiSchema } from "./check-api-schema.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "api-schema-test-"));
const repo = path.join(dir, "backend");
const out = path.join(dir, "schema.d.ts");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const spec = (status: number) =>
  `openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths:\n  /a:\n    get:\n      responses:\n        "${status}": { description: ok }\n`;
const commit = (status: number) => {
  writeFileSync(path.join(repo, "backend/openapi/openapi.yaml"), spec(status));
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", `spec ${status}`);
  return git("rev-parse", "HEAD");
};

mkdirSync(path.join(repo, "backend/openapi"), { recursive: true });
git("init", "-q");
const first = commit(200);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("generated from the paired sha passes; a missing file or a missing backend fails", () => {
  expect(checkApiSchema({ repo, out }).message).toMatch(/is missing/);
  expect(checkApiSchema({ repo, out, write: true }).ok).toBe(true);
  expect(checkApiSchema({ repo, out })).toMatchObject({ ok: true });
  expect(checkApiSchema({ repo: path.join(dir, "nowhere"), out }).ok).toBe(false);
  expect(checkApiSchema({ repo, ref: "no-such-ref", out }).ok).toBe(false);
});

test("a hand edit to the generated types fails", () => {
  const good = readFileSync(out, "utf8");
  writeFileSync(out, good.replace("200:", "201:"));
  const r = checkApiSchema({ repo, out });
  expect(r.ok).toBe(false);
  expect(r.message).toMatch(/api schema drift[\s\S]*- .*201:[\s\S]*\+ .*200:/);
  writeFileSync(out, good);
});

test("a backend contract change the client did not regenerate fails; pinning the old sha passes", () => {
  commit(204);
  const r = checkApiSchema({ repo, out });
  expect(r.ok).toBe(false);
  expect(r.message).toMatch(/api schema drift.*backend [0-9a-f]{12}/);
  expect(checkApiSchema({ repo, ref: first, out }).ok).toBe(true);
});
