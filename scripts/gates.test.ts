// Structural gates that run inside `npm test`, so `npm run check` enforces them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
};

test("check-source: imports, derived keys, slice placement, max-lines pins", () => run("node", ["scripts/check-source.mjs"]));
test("check-toolchain-pins: stable pins match the root and fuzz stays on nightly", () => run("node", ["scripts/check-toolchain-pins.mjs", "--check"]));
test("check-toolchain-pins rejects planted mismatches", () => run("node", ["--test", "scripts/check-toolchain-pins.test.mjs"]));
test("backend CI runs every release code gate and propagates failures", () => run("node", ["--test", "scripts/backend-code-gates.test.mjs"]));
// Measured at 19 s locally; 120 s allows about 6x headroom for runner contention.
test("canary Service resolution, distinct N-1, deadline budgets and readiness diagnostics", () => run("node", ["--test", "deploy/ci/canary.test.mjs", "deploy/ci/previous-release.test.mjs", "deploy/ci/rollout-deadline.test.mjs", "deploy/ci/diagnostics.test.mjs"]), 120000);
test("check-ds: no new raw controls, hand-written DS classes, control restyles or literal sizes (ratchet)", () => run("node", ["scripts/check-ds.mjs"]));
test("tsconfig.pure: domain rings and neutral packages compile without DOM", () => run("node_modules/.bin/tsc", ["-p", "apps/web/tsconfig.pure.json"]), 60000);
test("ai-quality: clones, error masking, test behavior, dead code and dependency evidence (ratchet)", () => run("node", ["scripts/check-ai-quality.mjs"]), 120000);
test("check-entity-names: an entity's name is read only through the one presentation (0h)", () => run("node", ["scripts/check-entity-names.mjs"]), 60000);
// Planted control: the gate refuses an entity's name read straight off its state, in either form and off a response's
// record, and passes a workplace's.
test("check-entity-names refuses a planted entity name read and passes a workplace's", () => {
  const fixture = path.join(mkdtempSync(path.join(tmpdir(), "entity-names-")), "planted.ts");
  const api = path.join(root, "packages/api/src/pending/entity");
  writeFileSync(fixture, [
    `import type { LegalEntity, Workplace } from ${JSON.stringify(api)};`,
    "export const label = (e: LegalEntity) => e.current?.name ?? \"\";",
    "export const site = (w: Workplace) => w.current?.name ?? \"\";",
    "export const spread = (e: LegalEntity) => { const { name } = e.current!; return name; };",
    // A response type openapi-fetch derives from the schema has no link to LegalEntityState's declaration (by shape).
    `import { createEntity } from ${JSON.stringify(path.join(root, "apps/web/src/features/entity/api"))};`,
    "export const quick = async () => (await createEntity(\"k\", {} as never)).record.current?.name;",
    "",
  ].join("\n"));
  const r = spawnSync("node", ["scripts/check-entity-names.mjs", fixture], { cwd: root, encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(1);
  const refused = r.stdout.split("\n").filter((l) => l.includes("planted.ts"));
  expect(refused.map((l) => l.replace(/^.*planted\.ts:(\d+):.*$/, "$1"))).toEqual(["2", "4", "6"]);
}, 60000);
