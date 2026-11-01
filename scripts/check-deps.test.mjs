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
    { kind: "npm", name: "react", direct: true, uses: [
      { file: "apps/web/package.json", user: "@console/web", layer: "web: UI" },
      { file: "packages/api/package.json", user: "@console/api", layer: "build/tooling" },
    ] },
    { kind: "npm", name: "vitest", direct: true, uses: [{ file: "package.json", layer: "test" }] },
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

test("registered pending dependencies cannot expand to a new consumer or layer", () => {
  const added = [...manifests, { file: "packages/x/package.json", json: { dependencies: { react: "^19" } } }];
  assert.match(checkDeps(added, register, lock).join("\n"), /use is not recorded/);
  const changed = [{ file: "package.json", json: { dependencies: { vitest: "^5" } } }];
  assert.match(checkDeps(changed, register, lock).join("\n"), /use is not recorded/);
  const renamed = structuredClone(manifests);
  renamed[1].json.name = "@console/other";
  assert.match(checkDeps(renamed, register, lock).join("\n"), /use is not recorded/);
});

test("an override cannot introduce an unregistered package", () => {
  const changed = [{ file: "package.json", json: { overrides: { vitest: { planted: "1.0.0" } } } }];
  assert.match(checkDeps(changed, register, lock).join("\n"), /planted.*not in the owner dependency register/);
});

test("Dependabot may update a recorded package requirement and lock without editing decisions", () => {
  const updated = structuredClone(manifests);
  updated[0].json.devDependencies.vitest = "^6";
  const updatedLock = structuredClone(lock);
  updatedLock.packages["node_modules/vitest"].version = "6.0.1";
  assert.deepEqual(checkDeps(updated, register, updatedLock), []);
});

test("reads nested and multiple resolved versions from the lock", () => {
  const nestedLock = { packages: { ...lock.packages, "apps/web/node_modules/react": { version: "19.2.0" } } };
  assert.deepEqual(checkDeps(manifests, register, nestedLock), []);
  delete nestedLock.packages["node_modules/react"];
  nestedLock.packages["apps/web/node_modules/react"].version = "19.2.1";
  assert.deepEqual(checkDeps(manifests, register, nestedLock), []);
});

test("refuses a declared package missing its resolved lock version", () => {
  for (const pin of [undefined, {}, { link: true, version: "19.3.1" }]) {
    const changedLock = structuredClone(lock);
    if (pin) changedLock.packages["node_modules/react"] = pin;
    else delete changedLock.packages["node_modules/react"];
    assert.match(checkDeps(manifests, register, changedLock).join("\n"), /react.*resolved version.*package-lock\.json/);
  }
});

test("allows override version bumps while refusing a new override target", () => {
  const current = [{ file: "package.json", json: { overrides: { parent: { react: "19.3.1" } } } }];
  const recorded = { rows: [{ ...register.rows[0], uses: [
    { file: "package.json", layer: "build/tooling", override: "parent > react" },
  ] }] };
  assert.deepEqual(checkDeps(current, recorded, lock), []);
  const changedLock = structuredClone(lock);
  changedLock.packages["node_modules/react"].version = "19.3.2";
  current[0].json.overrides.parent.react = "19.3.2";
  assert.deepEqual(checkDeps(current, recorded, changedLock), []);
  current[0].json.overrides.other = current[0].json.overrides.parent;
  assert.match(checkDeps(current, recorded, changedLock).join("\n"), /use is not recorded/);
});

test("CLI accepts a lock-only bump with the decision register unchanged", (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "check-deps-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts/quality", "docs/quality"]) mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["check-deps.mjs", "quality/tooling-inventory.mjs"])
    copyFileSync(new URL(file, import.meta.url), path.join(root, "scripts", file));
  const put = (file, json) => writeFileSync(path.join(root, file), JSON.stringify(json));
  put("package.json", manifests[0].json);
  put("package-lock.json", lock);
  put("docs/quality/dependency-register.json", register);
  const run = () => spawnSync(process.execPath, [path.join(root, "scripts/check-deps.mjs")], { encoding: "utf8" });
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  const changedLock = structuredClone(lock);
  changedLock.packages["node_modules/vitest"].version = "5.0.6";
  put("package-lock.json", changedLock);
  const bumped = run();
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, "docs/quality/dependency-register.json"), "utf8")), register);
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
