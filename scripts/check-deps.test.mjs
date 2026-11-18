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
  "node_modules/react": { version: "19.3.1", resolved: "https://registry.npmjs.org/react/-/react-19.3.1.tgz", integrity: "sha512-Zml4dHVyZQ==" },
  "node_modules/vitest": { version: "5.0.5", resolved: "https://registry.npmjs.org/vitest/-/vitest-5.0.5.tgz", integrity: "sha512-Zml4dHVyZQ==" },
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

test("the web workspace and root browser fixtures share one Vite server type", () => {
  const { packages } = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const vitePins = Object.keys(packages).filter(key => /(?:^|\/)node_modules\/vite$/.test(key));
  assert.deepEqual(vitePins, ["node_modules/vite"]);
});

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
  updatedLock.packages["node_modules/vitest"].resolved = "https://registry.npmjs.org/vitest/-/vitest-6.0.1.tgz";
  assert.deepEqual(checkDeps(updated, register, updatedLock), []);
});

for (const [kind, requirement, pin] of [
  ["alias", "npm:preact@10.0.0", { name: "preact", version: "10.0.0", resolved: "https://registry.npmjs.org/preact/-/preact-10.0.0.tgz" }],
  ["github", "github:evil/react#abc", { version: "19.3.1", resolved: "git+ssh://git@github.com/evil/react.git#abc" }],
  ["tarball", "https://evil.example/react.tgz", { version: "19.3.1", resolved: "https://evil.example/react.tgz" }],
  ["traversal", "^19", { version: "19.3.1", resolved: "https://registry.npmjs.org/react/-/../../preact/-/preact-10.0.0.tgz" }],
]) {
  test(`refuses ${kind} swaps under a registered package name`, () => {
    const changed = structuredClone(manifests);
    changed[1].json.dependencies.react = requirement;
    const changedLock = structuredClone(lock);
    changedLock.packages["node_modules/react"] = pin;
    assert.deepEqual(checkDeps(changed, register, changedLock), [
      '"react": resolved source must be its npm registry tarball in package-lock.json',
    ]);
  });
}

test("refuses missing, mismatched or noncanonical sources on any nested pin", () => {
  for (const resolved of [
    undefined,
    "not a URL",
    "https://registry.npmjs.org/preact/-/preact-10.0.0.tgz",
    "https://evil.example/react/-/react-19.3.1.tgz",
    "https://registry.npmjs.org/react/-/./react-19.3.1.tgz",
    "https://registry.npmjs.org/react/-/%2e/react-19.3.1.tgz",
  ]) {
    const changedLock = structuredClone(lock);
    changedLock.packages["apps/web/node_modules/react"] = { version: "19.3.1", resolved };
    assert.deepEqual(checkDeps(manifests, register, changedLock), [
      '"react": resolved source must be its npm registry tarball in package-lock.json',
    ]);
  }
});

test("accepts bundled copies without a resolved URL while checking other pins", () => {
  const changedLock = structuredClone(lock);
  changedLock.packages["node_modules/parent/node_modules/react"] = { version: "19.2.0", inBundle: true };
  assert.deepEqual(checkDeps(manifests, register, changedLock), []);
  changedLock.packages["node_modules/react"].resolved = "https://evil.example/react.tgz";
  assert.deepEqual(checkDeps(manifests, register, changedLock), [
    '"react": resolved source must be its npm registry tarball in package-lock.json',
  ]);
  changedLock.packages["node_modules/react"].inBundle = true;
  assert.deepEqual(checkDeps(manifests, register, changedLock), [
    '"react": resolved source must be its npm registry tarball in package-lock.json',
  ]);
});

test("reads nested and multiple resolved versions from the lock", () => {
  const nestedLock = { packages: { ...lock.packages, "apps/web/node_modules/react": { ...lock.packages["node_modules/react"], version: "19.2.0", resolved: "https://registry.npmjs.org/react/-/react-19.2.0.tgz" } } };
  assert.deepEqual(checkDeps(manifests, register, nestedLock), []);
  delete nestedLock.packages["node_modules/react"];
  nestedLock.packages["apps/web/node_modules/react"].version = "19.2.1";
  assert.deepEqual(checkDeps(manifests, register, nestedLock), []);
});

test("refuses registry pins without an integrity hash, including nested copies", () => {
  for (const location of ["node_modules/react", "apps/web/node_modules/react"]) {
    for (const integrity of [undefined, "", "not-a-hash"]) {
      const changed = structuredClone(lock);
      changed.packages[location] = { ...lock.packages["node_modules/react"], integrity };
      assert.match(checkDeps(manifests, register, changed).join("\n"), /react.*integrity/);
    }
  }
});

function routineUpdate(oldVersion = "5.0.5", version = "5.1.0") {
  const current = [{ file: "package.json", json: { devDependencies: { vitest: `^${version}` } } }];
  const previous = { "package.json": { devDependencies: { vitest: `^${oldVersion}` } } };
  const pin = (value) => ({ version: value, license: "MIT", integrity: "sha512-Zml4dHVyZQ==", resolved: `https://registry.npmjs.org/vitest/-/vitest-${value}.tgz` });
  return {
    current, previous, notes: {}, lock: { packages: { "node_modules/vitest": pin(version) } },
    evidence: { register: structuredClone(register), previousRegister: structuredClone(register), previousLock: { packages: { "node_modules/vitest": pin(oldVersion) } } },
  };
}

const verifyUpdate = (f) => checkDependencyNotes(f.current, f.previous, f.notes, f.lock, () => { throw new Error("routine updates must not read a note"); }, f.evidence);

for (const [oldVersion, version] of [["5.0.5", "5.1.0"], ["5.0.5", "5.0.6"], ["0.5.1", "0.5.2"]]) {
  test(`registered routine update ${oldVersion} → ${version} uses automated evidence without a note`, () => {
    assert.deepEqual(verifyUpdate(routineUpdate(oldVersion, version)), []);
  });
}

for (const [reason, change] of [
  ["new package", (f) => { f.previous = {}; f.evidence.previousRegister.rows = []; }],
  ["new declaration of a registered package", (f) => { f.previous = {}; }],
  ["unrecorded consumer", (f) => { f.current[0].json.name = "another-user"; }],
  ["new use even if added to the current register", (f) => {
    f.current[0].json.name = "another-user";
    f.evidence.register.rows.find((r) => r.name === "vitest").uses[0].user = "another-user";
  }],
  ["new layer", (f) => { f.current[0].json.dependencies = f.current[0].json.devDependencies; delete f.current[0].json.devDependencies; }],
  ["changed owner decision", (f) => { f.evidence.register.rows[1].approval = { by: "owner" }; }],
  ["missing register", (f) => { delete f.evidence.register; }],
  ["missing previous register", (f) => { delete f.evidence.previousRegister; }],
  ["missing previous pin", (f) => { f.evidence.previousLock = { packages: {} }; }],
  ["missing current pin", (f) => { f.lock = { packages: {} }; }],
  ["changed licence", (f) => { f.lock.packages["node_modules/vitest"].license = "GPL-3.0-only"; }],
  ["missing licence", (f) => { delete f.lock.packages["node_modules/vitest"].license; }],
  ["missing previous licence", (f) => { delete f.evidence.previousLock.packages["node_modules/vitest"].license; }],
  ["missing integrity", (f) => { delete f.lock.packages["node_modules/vitest"].integrity; }],
  ["non-registry source", (f) => { f.lock.packages["node_modules/vitest"].resolved = "https://example.com/vitest.tgz"; }],
]) {
  test(`${reason} still requires a verification note`, () => {
    const f = routineUpdate();
    change(f);
    assert.match(verifyUpdate(f).join("\n"), /needs a verification note/);
  });
}

for (const [oldVersion, version] of [["5.0.5", "6.0.0"], ["0.5.1", "0.6.0"], ["5.0.5", "5.1.0-beta.1"]]) {
  test(`incompatible or prerelease update ${oldVersion} → ${version} needs a note`, () => {
    assert.match(verifyUpdate(routineUpdate(oldVersion, version)).join("\n"), /needs a verification note/);
  });
}

test("lock-only changes cannot bypass major and licence review", () => {
  for (const kind of ["routine", "major", "licence"]) {
    const f = routineUpdate("5.0.5", kind === "major" ? "6.0.0" : "5.1.0");
    f.current[0].json.devDependencies.vitest = f.previous["package.json"].devDependencies.vitest;
    if (kind === "licence") f.lock.packages["node_modules/vitest"].license = "GPL-3.0-only";
    const problems = verifyUpdate(f);
    if (kind === "routine") assert.deepEqual(problems, []);
    else assert.match(problems.join("\n"), /needs a verification note/);
  }
});

test("a new consumer needs review even without a version change", () => {
  const f = routineUpdate("5.0.5", "5.0.5");
  f.current[0].json.name = "another-user";
  f.evidence.register.rows[1].uses[0].user = "another-user";
  assert.match(verifyUpdate(f).join("\n"), /needs a verification note/);
});

for (const version of ["5.0.5", "5.1.0"]) {
  test(`a callsite move needs no note for vitest 5.0.5 → ${version}`, () => {
    const f = routineUpdate("5.0.5", version);
    f.evidence.previousRegister.rows[1].callsites = ["package.json:10"];
    f.evidence.register.rows[1].callsites = ["package.json:11"];
    assert.deepEqual(verifyUpdate(f), []);
  });
}

test("an owner ruling needs no dependency note for an unchanged declaration and pin", () => {
  const f = routineUpdate("5.0.5", "5.0.5");
  f.evidence.register.rows[1].approval = { by: "owner" };
  assert.deepEqual(verifyUpdate(f), []);
});

test("workspace updates compare their nearest installed pins rather than a hoisted copy", () => {
  const f = routineUpdate();
  f.current[0].file = "apps/web/package.json";
  f.previous["apps/web/package.json"] = f.previous["package.json"];
  const use = { file: "apps/web/package.json", layer: "test" };
  for (const r of [f.evidence.register, f.evidence.previousRegister]) r.rows[1].uses = [use];
  const nested = "apps/web/node_modules/vitest";
  for (const l of [f.lock, f.evidence.previousLock]) l.packages[nested] = structuredClone(l.packages["node_modules/vitest"]);
  f.lock.packages["node_modules/vitest"].license = "GPL-3.0-only";
  assert.deepEqual(verifyUpdate(f), []);
  f.lock.packages[nested].license = "GPL-3.0-only";
  assert.match(verifyUpdate(f).join("\n"), /needs a verification note/);
});

test("routine updates in workspaces preserve internal workspace declarations", () => {
  const f = routineUpdate();
  f.current[0].json.dependencies = { "@console/api": "*" };
  f.current.push({ file: "packages/api/package.json", json: { name: "@console/api" } });
  assert.deepEqual(verifyUpdate(f), []);
});

test("an incompatible update can still supply its version-specific review note", () => {
  const f = routineUpdate("5.0.5", "6.0.0");
  f.notes["package.json:devDependencies:vitest"] = {
    requirement: "^6.0.0", version: "6.0.0", registry: "https://registry.npmjs.org/vitest/6.0.0",
    checked: "2026-11-18", note: "docs/quality/dependencies/vitest-major.md",
  };
  assert.deepEqual(checkDependencyNotes(f.current, f.previous, f.notes, f.lock,
    () => "Reason: migration reviewed\nProvenance: registry verified\nLicense: MIT reviewed\nSecurity: advisories reviewed", f.evidence), []);
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
