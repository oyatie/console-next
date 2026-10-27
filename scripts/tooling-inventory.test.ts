// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import { cargoPins, inventory, render, reviewRows } from "./quality/tooling-inventory.mjs";

const fixture = {
  "package.json": JSON.stringify({ name: "root", devDependencies: { oxlint: "1" }, overrides: { old: { child: "2" } } }),
  "apps/web/package.json": JSON.stringify({ name: "@console/web", dependencies: { react: "19", "@console/api": "*" } }),
  "packages/api/package.json": JSON.stringify({ name: "@console/api" }),
  "package-lock.json": JSON.stringify({ packages: { "node_modules/react": { version: "19", license: "MIT" }, "node_modules/child": { version: "2" } } }),
  ".github/workflows/check.yml": "- uses: actions/checkout@sha\n  run: docker run --rm image/tool@sha256:abc\n- uses: docker://alpine:3\n",
  "Dockerfile": "FROM rust:1 AS build\nFROM scratch\nCOPY --from=build /app /app\n",
  "scripts/check-sample.mjs": "// Samples must be valid.\nthrow Error('invalid');",
  "scripts/check-sample.test.mjs": "// Test, not a gate.",
  "apps/web/src/view.tsx": "import { useState } from 'react';",
};
const scan = (extra = {}, cargo = []) => inventory(Object.keys({ ...fixture, ...extra }), (p) => ({ ...fixture, ...extra })[p], cargo);

describe("tooling inventory", () => {
  test("Cargo-generated lock records include fuzz-only and duplicate-version pins; malformed records refuse", () => {
    const lock = 'version = 4\n\n[[package]]\nname = "fuzz-only"\nversion = "1.0.0"\nsource = "registry+source"\n\n[[package]]\nname = "fuzz-only"\nversion = "2.0.0"\n';
    expect(cargoPins(lock).map((p) => p.version)).toEqual(["1.0.0", "2.0.0"]);
    expect(scan({ "backend/fuzz/Cargo.lock": lock }).find((r) => r.name === "fuzz-only")?.pins).toHaveLength(2);
    expect(() => cargoPins('[[package]]\nname = "incomplete"')).toThrow("invalid Cargo lock package record");
  });
  test("discovers declarations, overrides, transitives, actions, images and gates without workspace packages", () => {
    const rows = scan();
    expect(rows.filter((r) => r.kind === "npm").map((r) => r.name).sort()).toEqual(["child", "oxlint", "react"]);
    expect(rows.find((r) => r.name === "react")?.callsites).toContain("apps/web/src/view.tsx:1");
    expect(rows.filter((r) => r.kind === "container").map((r) => r.name).sort()).toEqual(["alpine", "image/tool", "rust"]);
    expect(rows.filter((r) => r.kind === "gate").map((r) => r.name)).toEqual(["scripts/check-sample.mjs"]);
    expect(rows.some((r) => r.name === "actions/checkout")).toBe(true);
  });
  test("discovers locked Cargo CI tools from their workflow version pins and refuses missing pins", () => {
    const workflow = 'env:\n  AUDIT_VERSION: 0.22.2\nsteps:\n  - run: cargo install cargo-audit --locked --version "${AUDIT_VERSION}"\n';
    expect(scan({ ".github/workflows/check.yml": workflow }).find((r) => r.name === "cargo-audit")?.uses[0].pin).toBe("0.22.2");
    expect(() => scan({ ".github/workflows/check.yml": workflow.replace("  AUDIT_VERSION: 0.22.2\n", "") })).toThrow("missing pinned tool version");
  });
  test("explicit dated owner approval does not require a delegated STANDARD assessment", () => {
    const row = { kind: "ci-tool", name: "cargo-audit", direct: true, uses: [], evidence: [] };
    const review = { class: "STANDARD", approval: { by: "owner", on: "2026-10-27", ruling: "approved" }, architectureRecord: "docs/architecture/frontend-module-map.md" };
    expect(reviewRows([row], { "ci-tool:cargo-audit": review })[0].approval).toEqual(review.approval);
    expect(() => reviewRows([row], { "ci-tool:cargo-audit": { ...review, approval: { ...review.approval, on: "" } } })).toThrow("unproven STANDARD");
  });
  test("new direct dependencies and gates cannot disappear behind the existing census", () => {
    const rows = scan({ "packages/api/package.json": '{"name":"@console/api","dependencies":{"planted":"1"}}', "scripts/check-planted.mjs": "// Planted contract." });
    expect(rows.some((r) => r.name === "planted" && r.direct)).toBe(true);
    expect(rows.some((r) => r.name === "scripts/check-planted.mjs")).toBe(true);
    expect(() => reviewRows(rows, {})).toThrow(/missing review/);
  });
  test("platform locks expose installed tools, concrete build images and vendored sources", () => {
    const rows = scan({
      "deploy/versions.json": JSON.stringify({ tools: { cluster: { version: "1", files: { linux: { url: "https://upstream/tool", sha256: "abc" } } } }, images: { node: "registry/node@sha256:123" }, platformImages: { controller: "registry/controller@sha256:456" }, sources: { schema: { repository: "upstream/schema", commit: "sha" } } }),
      "deploy/images/app.Dockerfile": "ARG NODE_IMAGE\nFROM ${NODE_IMAGE}\n",
    });
    expect(rows.find((r) => r.name === "cluster")?.kind).toBe("ci-tool");
    expect(rows.find((r) => r.name === "registry/node")?.uses).toHaveLength(2);
    expect(rows.some((r) => r.name === "registry/controller")).toBe(true);
    expect(rows.find((r) => r.name === "schema")?.kind).toBe("ci-source");
    expect(() => scan({ "unknown.Dockerfile": "FROM ${UNDECLARED_IMAGE}\n" })).toThrow("unresolved Dockerfile image argument");
  });
  test("Cargo aliases, target and dev dependencies survive; patched externals are not first-party", () => {
    const cargo = [{ workspace_members: ["own"], packages: [{ id: "own", name: "console-test-domain", manifest_path: "backend/crates/test/domain/Cargo.toml", dependencies: [
      { name: "tokio", rename: "runtime", kind: null, req: "1", target: "cfg(unix)", features: ["rt"] },
      { name: "calamine", path: "third-party/rust/vendor/calamine", kind: "dev", req: "1", features: [] },
      { name: "console-core", path: "backend/crates/core", kind: null, req: "*", features: [] },
    ] }], resolve: null }];
    const rows = scan({}, cargo);
    expect(rows.find((r) => r.name === "tokio")?.uses[0]).toMatchObject({ alias: "runtime", target: "cfg(unix)", layer: "domain/entities" });
    expect(rows.find((r) => r.name === "calamine")?.uses[0].layer).toBe("test");
    expect(rows.some((r) => r.name === "console-core")).toBe(false);
  });
  test("unproven criteria never become delegated approval", () => {
    const rows = [{ kind: "npm", name: "react", direct: true, uses: [], callsites: [], evidence: [] }];
    const reviews = { "npm:react": { job: "UI", verdict: "keep", class: "NEEDS-OWNER", approval: null } };
    const reviewed = reviewRows(rows, reviews);
    expect(reviewed[0].approval).toBeNull();
    expect(render(reviewed)).toContain("NEEDS-OWNER");
    expect(() => reviewRows(rows, { "npm:react": { ...reviews["npm:react"], class: "STANDARD" } })).toThrow("unproven STANDARD");
  });
});
