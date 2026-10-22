// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { FACTS, UNTRACKED } from "../e2e/record-actions/facts";
import { koEntityRecord } from "../packages/i18n/src/catalogs/ko/entity-record";

test("the entity header's certificate edit remains covered by the reach census", () => {
  const label = koEntityRecord["entityRecord.action.editByCert"].replace(/ 수정$/, "");
  expect([...FACTS.map((fact) => fact.label), ...UNTRACKED]).toContain(label);
});

test("the registry slice records the missing API and export proof instead of closing #47", () => {
  const report = readFileSync(new URL("../e2e/record-actions/README.md", import.meta.url), "utf8");
  expect(report).toMatch(/2026-10-22.*API \+ export surfaces/);
  expect(report).toContain("GET /api/v1/employees");
  expect(report).toContain("GET /api/v1/employees/export.csv");
  expect(report).toContain("#47 remains open");
  expect(report).not.toMatch(/remainders: none|MEETS S3-entity-revise/);
});
