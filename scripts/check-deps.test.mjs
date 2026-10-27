// SPDX-License-Identifier: LicenseRef-Proprietary
// node --test scripts/check-deps.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDependencyNotes, checkDeps } from "./check-deps.mjs";

const manifests = [
  { file: "package.json", json: { devDependencies: { vitest: "^5" } } },
  { file: "apps/web/package.json", json: { name: "@console/web", dependencies: { "@console/api": "*", react: "^19" } } },
  { file: "packages/api/package.json", json: { name: "@console/api", peerDependencies: { react: "^19" } } },
];

const register = {
  rows: [
    { kind: "npm", name: "react", direct: true, uses: [
      { file: "apps/web/package.json", user: "@console/web", requirement: "^19", layer: "web: UI" },
      { file: "packages/api/package.json", user: "@console/api", requirement: "^19", layer: "build/tooling" },
    ] },
    { kind: "npm", name: "vitest", direct: true, uses: [{ file: "package.json", requirement: "^5", layer: "test" }] },
  ],
};

test("passes recorded external declarations and real workspace dependencies", () => {
  assert.deepEqual(checkDeps(manifests, register), []);
});

test("refuses an unregistered package, including a fake workspace name", () => {
  for (const name of ["lodash", "@console/not-a-workspace"]) {
    const added = [...manifests, { file: "packages/x/package.json", json: { optionalDependencies: { [name]: "^4" } } }];
    assert.match(checkDeps(added, register).join("\n"), /not in the owner dependency register/);
  }
});

test("inventory of a transitive package does not allow a direct declaration", () => {
  assert.match(checkDeps(manifests, { rows: register.rows.map((r) => ({ ...r, direct: false })) }).join("\n"), /not in the owner dependency register/);
});

test("registered pending dependencies cannot expand to a new user or requirement", () => {
  const added = [...manifests, { file: "packages/x/package.json", json: { dependencies: { react: "^19" } } }];
  assert.match(checkDeps(added, register).join("\n"), /use is not recorded/);
  const changed = [{ file: "package.json", json: { devDependencies: { vitest: "^6" } } }];
  assert.match(checkDeps(changed, register).join("\n"), /use is not recorded/);
});

test("an override cannot introduce an unregistered package", () => {
  const changed = [{ file: "package.json", json: { overrides: { vitest: { planted: "1.0.0" } } } }];
  assert.match(checkDeps(changed, register).join("\n"), /planted.*not in the owner dependency register/);
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
