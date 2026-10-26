// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { inventory, reviewRows } from "./quality/tooling-inventory.mjs";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const register = () => JSON.parse(read("docs/quality/dependency-register.json")).rows;
const approved = [
  "npm:react", "npm:react-dom", "npm:@types/react", "npm:@types/react-dom", "npm:@playwright/test", "npm:typescript", "npm:@types/node",
  "ci-tool:Rust", "ci-tool:Chromium", "ci-tool:Node.js",
  "action:actions/checkout", "action:actions/setup-node", "action:actions/upload-artifact", "action:actions/download-artifact",
  ...["tokio", "bytes", "http", "futures", "serde", "serde_json", "uuid", "url", "tracing", "tracing-subscriber", "stacker", "base64", "zeroize", "rustls", "tokio-rustls"].map((name) => `cargo:${name}`),
];
const kinds = new Set(["npm", "cargo", "action", "container", "ci-tool"]);

describe("2026-10-26 delegated dependency ruling", () => {
  test("records exactly the 29 approvals and returns the four Beta trace dependencies to the owner", () => {
    const rows = register().filter((r) => kinds.has(r.kind));
    expect(rows).toHaveLength(147);
    expect(rows.filter((r) => r.class === "STANDARD").map((r) => `${r.kind}:${r.name}`).sort()).toEqual(approved.sort());
    expect(rows.filter((r) => r.class === "NEEDS-OWNER")).toHaveLength(118);
    for (const name of ["opentelemetry", "opentelemetry_sdk", "opentelemetry-otlp", "tracing-opentelemetry"]) {
      expect(rows.find((r) => r.kind === "cargo" && r.name === name)).toMatchObject({ class: "NEEDS-OWNER", approval: null, group: "Observability" });
    }
    for (const row of rows.filter((r) => r.class === "STANDARD")) {
      expect(row.approval.ruling).toContain("2026-10-26");
      for (const criterion of ["a", "b", "c", "d", "e"]) expect(row.standardTest[criterion]).toMatchObject({ result: "pass", source: expect.any(String), reason: expect.any(String) });
    }
  });

  test("transitive inventory carries no independent approval, verdict or owner classification", () => {
    const transitive = { kind: "npm", name: "implementation-only", direct: false, uses: [], evidence: [] };
    const [row] = reviewRows([transitive], {});
    for (const field of ["class", "approval", "verdict"]) expect(row).not.toHaveProperty(field);
    expect(register().every((r) => r.direct)).toBe(true);
    const rows = JSON.parse(read("docs/quality/dependency-transitive-inventory.json")).rows;
    expect(rows.length).toBeGreaterThan(1000);
    expect(rows.every((r) => !r.direct && !["class", "approval", "verdict"].some((key) => key in r))).toBe(true);
  });

  test("owner summary covers each unresolved direct dependency once with one recommendation per group", () => {
    const summary = read("docs/quality/dependency-owner-summary.md");
    const pending = register().filter((r) => kinds.has(r.kind) && r.class === "NEEDS-OWNER");
    const listed = [...summary.matchAll(/`((?:npm|cargo|action|container|ci-tool):[^`]+)`/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual(pending.map((r) => `${r.kind}:${r.name}`).sort());
    const groups = [...new Set(pending.map((r) => r.group))];
    const tableRows = summary.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Group") && !line.startsWith("| ---"));
    expect(tableRows).toHaveLength(groups.length);
    for (const group of groups) expect(tableRows.filter((line) => line.startsWith(`| ${group} (`))).toHaveLength(1);
  });

  test("every approval is recorded in its architecture with exact users, ruling and exit plan", () => {
    for (const row of register().filter((r) => r.class === "STANDARD")) {
      const map = read(row.architectureRecord);
      const entry = map.split("\n").find((line) => line.startsWith(`| \`${row.kind}:${row.name}\` |`));
      expect(entry, row.name).toBeDefined();
      expect(entry).toContain(row.layer);
      expect(entry).toContain("2026-10-26");
      expect(entry).toContain(row.exitPlan);
      expect(row.approvedUsers.length).toBeGreaterThan(0);
      for (const user of row.approvedUsers) expect(entry).toContain(`\`${user}\``);
      expect(row.standardTest.e.source).toBe(row.architectureRecord);
      expect(row.uses.filter((use) => !row.allowedLayers.includes(use.layer)).every((use) => row.layerFindings.some((finding) => finding.includes(use.user)))).toBe(true);
    }
  });

  test("compiler and type declarations installed as dev dependencies belong to build/tooling", () => {
    const source = JSON.stringify({ name: "console-react", devDependencies: { typescript: "1", "@types/node": "1" } });
    const rows = inventory(["package.json"], () => source);
    expect(rows.every((r) => r.uses[0].layer === "build/tooling")).toBe(true);
  });

  test("summary refuses a new unresolved group without its owner recommendation", async () => {
    const { renderOwnerSummary } = await import("./quality/tooling-inventory.mjs");
    const row = { kind: "npm", name: "pending", direct: true, class: "NEEDS-OWNER", group: "Unreviewed group" };
    expect(() => renderOwnerSummary([row], {})).toThrow("missing owner group recommendation: Unreviewed group");
  });
});
