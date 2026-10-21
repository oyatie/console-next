// node --test scripts/check-deps.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDependencyNotes, checkDeps } from "./check-deps.mjs";

const manifests = [
  { file: "package.json", json: { devDependencies: { vitest: "^5" } } },
  { file: "apps/web/package.json", json: { name: "@console/web", dependencies: { "@console/api": "*", react: "^19" } } },
  { file: "packages/api/package.json", json: { name: "@console/api", peerDependencies: { react: "^19" } } },
];

test("passes when every external dependency is allowlisted; workspace packages are implicit", () => {
  assert.deepEqual(checkDeps(manifests, ["react", "vitest"]), []);
});

test("fails on an unlisted dependency in any field of any manifest", () => {
  const added = [...manifests, { file: "packages/x/package.json", json: { optionalDependencies: { lodash: "^4" } } }];
  assert.deepEqual(checkDeps(added, ["react", "vitest"]), [
    'packages/x/package.json: optionalDependencies "lodash" is not on the allowlist',
  ]);
});

test("fails on a stale allowlist entry", () => {
  assert.deepEqual(checkDeps(manifests, ["react", "vitest", "left-pad"]), [
    'allowlist: "left-pad" is not used by any package.json',
  ]);
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
