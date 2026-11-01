// SPDX-License-Identifier: LicenseRef-Proprietary
// node --test scripts/check-deps.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkDependencyNotes, checkDeps } from "./check-deps.mjs";

const manifests = [
  { file: "package.json", json: { devDependencies: { vitest: "^5" } } },
  { file: "apps/web/package.json", json: { name: "@console/web", dependencies: { "@console/api": "*", react: "^19" } } },
  { file: "packages/api/package.json", json: { name: "@console/api", peerDependencies: { react: "^19" } } },
];

const lock = { packages: {
  "node_modules/react": { version: "19.3.1" },
  "node_modules/vitest": { version: "5.0.5" },
} };

const register = {
  rows: [
    { kind: "npm", name: "react", direct: true, pins: [{ location: "node_modules/react", version: "19.3.1" }], uses: [
      { file: "apps/web/package.json", user: "@console/web", requirement: "^19", layer: "web: UI" },
      { file: "packages/api/package.json", user: "@console/api", requirement: "^19", layer: "build/tooling" },
    ] },
    { kind: "npm", name: "vitest", direct: true, pins: [{ location: "node_modules/vitest", version: "5.0.5" }], uses: [{ file: "package.json", requirement: "^5", layer: "test" }] },
  ],
};

test("passes recorded external declarations and real workspace dependencies", () => {
  assert.deepEqual(checkDeps(manifests, register, lock), []);
});

test("refuses an unregistered package, including a fake workspace name", () => {
  for (const name of ["lodash", "@console/not-a-workspace"]) {
    const added = [...manifests, { file: "packages/x/package.json", json: { optionalDependencies: { [name]: "^4" } } }];
    assert.match(checkDeps(added, register, lock).join("\n"), /not in the owner dependency register/);
  }
});

test("inventory of a transitive package does not allow a direct declaration", () => {
  assert.match(checkDeps(manifests, { rows: register.rows.map((r) => ({ ...r, direct: false })) }, lock).join("\n"), /not in the owner dependency register/);
});

test("registered pending dependencies cannot expand to a new user or requirement", () => {
  const added = [...manifests, { file: "packages/x/package.json", json: { dependencies: { react: "^19" } } }];
  assert.match(checkDeps(added, register, lock).join("\n"), /use is not recorded/);
  const changed = [{ file: "package.json", json: { devDependencies: { vitest: "^6" } } }];
  assert.match(checkDeps(changed, register, lock).join("\n"), /use is not recorded/);
});

test("an override cannot introduce an unregistered package", () => {
  const changed = [{ file: "package.json", json: { overrides: { vitest: { planted: "1.0.0" } } } }];
  assert.match(checkDeps(changed, register, lock).join("\n"), /planted.*not in the owner dependency register/);
});

test("refuses stale, missing and surplus register lock versions", () => {
  for (const pins of [
    [{ location: "node_modules/react", version: "19.3.0" }],
    [],
    [...register.rows[0].pins, { location: "apps/web/node_modules/react", version: "19.2.0" }],
  ]) {
    const changed = structuredClone(register);
    changed.rows[0].pins = pins;
    assert.match(checkDeps(manifests, changed, lock).join("\n"), /react.*lock versions.*package-lock\.json/);
  }
});

test("compares nested lock locations and all versions, regardless of register pin order", () => {
  const nested = { location: "apps/web/node_modules/react", version: "19.2.0" };
  const changed = structuredClone(register);
  changed.rows[0].pins.unshift(nested);
  const nestedLock = { packages: { ...lock.packages, [nested.location]: { version: nested.version } } };
  assert.deepEqual(checkDeps(manifests, changed, nestedLock), []);
  nestedLock.packages[nested.location].version = "19.2.1";
  assert.match(checkDeps(manifests, changed, nestedLock).join("\n"), /react.*lock versions.*package-lock\.json/);
});

test("checks registered override pins without registering unrelated transitive packages", () => {
  const current = [{ file: "package.json", json: { overrides: { parent: { react: "19.3.1" } } } }];
  const recorded = { rows: [{ ...register.rows[0], uses: [
    { file: "package.json", requirement: "19.3.1", layer: "build/tooling", override: "parent > react" },
  ] }] };
  assert.deepEqual(checkDeps(current, recorded, lock), []);
  const changedLock = structuredClone(lock);
  changedLock.packages["node_modules/react"].version = "19.3.2";
  assert.match(checkDeps(current, recorded, changedLock).join("\n"), /react.*lock versions.*package-lock\.json/);
});

test("CLI refuses a stale register version while manifests and lock stay unchanged", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "check-deps-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts/quality", "docs/quality"]) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["check-deps.mjs", "quality/tooling-inventory.mjs"])
    copyFileSync(new URL(file, import.meta.url), path.join(root, "scripts", file));
  const put = (file, json) => writeFileSync(path.join(root, file), JSON.stringify(json));
  put("package.json", manifests[0].json);
  put("package-lock.json", lock);
  const changed = structuredClone(register);
  put("docs/quality/dependency-register.json", changed);
  const run = () => spawnSync(process.execPath, [path.join(root, "scripts/check-deps.mjs")], { encoding: "utf8" });
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  changed.rows[1].pins[0].version = "5.0.4";
  put("docs/quality/dependency-register.json", changed);
  const refused = run();
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /vitest.*lock versions.*package-lock\.json/);
});

test("names a missing verification note without throwing", () => {
  const current = [{ file: "package.json", json: { dependencies: { example: "^1" } } }];
  const key = "package.json:dependencies:example";
  const note = "docs/quality/dependencies/missing-example.md";
  const notes = { [key]: { requirement: "^1", version: "1.2.3", registry: "https://registry.npmjs.org/example/1.2.3", checked: "2026-11-02", note } };
  const pinned = { packages: { "node_modules/example": { version: "1.2.3", integrity: "fixture-integrity" } } };
  const missing = () => readFileSync(new URL("../" + note, import.meta.url), "utf8");
  assert.deepEqual(checkDependencyNotes(current, {}, notes, pinned, missing), [
    `${key}: verification note file is missing: ${note}`,
  ]);
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(() => checkDependencyNotes(current, {}, notes, pinned, () => { throw denied; }), (error) => error === denied);
});

test("does not treat inherited previous-dependency entries as verified", () => {
  const file = "package.json";
  const name = "example";
  const requirement = "^1";
  const current = [{ file, json: { dependencies: { [name]: requirement } } }];
  const inheritedValue = { dependencies: { [name]: requirement } };
  const inheritedDependency = Object.create({ [name]: requirement });
  const previousCases = [
    Object.create({ [file]: inheritedValue }),
    { [file]: Object.create({ dependencies: inheritedValue.dependencies }) },
    { [file]: { dependencies: inheritedDependency } },
  ];

  for (const previous of previousCases) {
    assert.equal(
      checkDependencyNotes(current, previous, {}, { packages: {} }, () => "").length,
      1,
    );
  }
});
