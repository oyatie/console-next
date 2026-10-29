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
const ownerApproved = ["container:docker.io/chrislusf/seaweedfs", "ci-tool:cargo-deny", "ci-tool:cargo-audit", "ci-tool:fontTools/pyftsubset", "ci-tool:brotli"];
const kinds = new Set(["npm", "cargo", "action", "container", "ci-tool"]);

describe("2026-10-26 delegated dependency ruling", () => {
  test("preserves the delegated ruling and includes subsequent explicit owner approvals", () => {
    const rows = register().filter((r) => kinds.has(r.kind));
    expect(rows).toHaveLength(151);
    expect(rows.filter((r) => r.class === "STANDARD").map((r) => `${r.kind}:${r.name}`).sort()).toEqual([...approved, ...ownerApproved].sort());
    expect(rows.filter((r) => r.class === "NEEDS-OWNER")).toHaveLength(117);
    for (const name of ["opentelemetry", "opentelemetry_sdk", "opentelemetry-otlp", "tracing-opentelemetry"]) {
      expect(rows.find((r) => r.kind === "cargo" && r.name === name)).toMatchObject({ class: "NEEDS-OWNER", approval: null, group: "Observability" });
    }
    for (const row of rows.filter((r) => r.class === "STANDARD")) {
      if (row.approval.by === "owner") {
        expect(row.approval.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(row.approval.ruling.length).toBeGreaterThan(0);
        continue;
      }
      expect(row.approval.ruling).toContain("2026-10-26");
      for (const criterion of ["a", "b", "c", "d", "e"]) expect(row.standardTest[criterion]).toMatchObject({ result: "pass", source: expect.any(String), reason: expect.any(String) });
    }
  });

  test("Brotli 1.2.0 has its own owner-approved build tooling record for fontTools WOFF2 compression", () => {
    expect(register().find(r => r.kind === "ci-tool" && r.name === "brotli")).toMatchObject({
      class: "STANDARD", approved_by: "owner", approval: { by: "owner", on: "2026-10-29" },
      job: "WOFF2 compression for fontTools subsets", layer: "build/tooling", allowedLayers: ["build/tooling"],
      uses: [{ file: "apps/web/font-subsets.requirements.txt", user: "scripts/font-subsets.mjs", pin: "brotli==1.2.0", layer: "build/tooling" }],
    });
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
      expect(entry).toContain(row.approval.on ?? "2026-10-26");
      expect(entry).toContain(row.exitPlan);
      expect(row.approvedUsers.length).toBeGreaterThan(0);
      for (const user of row.approvedUsers) expect(entry).toContain(`\`${user}\``);
      if (row.approval.by !== "owner") expect(row.standardTest.e.source).toBe(row.architectureRecord);
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
