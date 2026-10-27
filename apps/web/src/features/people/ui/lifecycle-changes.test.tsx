// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { LifecycleChanges } from "./lifecycle-changes";
import { EMPTY } from "./use-lifecycle-draft";

type Unit = components["schemas"]["OrgUnitHead"];
type Employee = components["schemas"]["Employee"];
const units = [
  { id: "site-unit", name: "본사", kind: "SITE", parentId: null, headcount: 1 },
  { id: "target", name: "인사팀", kind: "DEPARTMENT", parentId: "site-unit", headcount: 2 },
] as Unit[];
const words = { fromGrade: "", toGrade: "", fromRole: "", toRole: "", fromJob: "", toJob: "", fromFamily: "", toFamily: "", fromType: "", toType: "" };
beforeAll(() => loadCatalog("ko"));

test.each([null, "site-unit"])("a workplace-direct origin (%s) names its placement without an unknown department", (orgUnit) => {
  const employee = { org_unit_id: orgUnit, org_unit: orgUnit ? "본사" : null, workplace_id: "workplace" } as Employee;
  const html = renderToStaticMarkup(<LifecycleChanges kind="TRANSFER" e={employee} units={units} v={{ ...EMPTY, unit: "target" }} words={words} site={{ from: "본사", to: "본사" }} />);
  expect(html).toContain("사업장 직속");
  expect(html).toContain("→ 인사팀");
  expect(html).not.toContain("—");
  expect(html).not.toContain("명부");
});

test("the workplace row has one from-to pair without an embedded consequence", () => {
  const employee = { org_unit_id: "old-unit", org_unit: "재무팀", workplace_id: "branch" } as Employee;
  const html = renderToStaticMarkup(<LifecycleChanges kind="TRANSFER" e={employee} units={units} v={{ ...EMPTY, unit: "target" }} words={words} site={{ from: "부산사업장", to: "본사" }} />);
  expect(html).toContain("부산사업장</td>");
  expect(html).toContain("→ 본사");
  expect(html).not.toContain("전근");
  expect(html).not.toContain("명부");
});
