// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { EMPTY } from "../domain/register";
import { RegisterPlace } from "./register-place";

beforeAll(() => loadCatalog("ko"));
const unit: ComponentProps<typeof RegisterPlace>["units"][number] = { id: "site", kind: "SITE", name: "본사", parentId: null, status: "ACTIVE", effectiveFrom: "2020-03-02", headcount: 0, updatedAt: "2026-10-24T00:00:00Z" };
const render = (hidePreview: boolean) => renderToStaticMarkup(<RegisterPlace d={{ ...EMPTY, where: "site", unitId: unit.id }} set={() => {}} units={[unit]} options={[{ unit, entity: "법인", entityId: "entity", workplaceId: "workplace", site: unit.name }]} workplaces={[]} shown={new Set()} hireLabel={null} hidePreview={hidePreview} />);

test("a refused hire never promises registration in the workplace register", () => {
  expect(render(true)).not.toContain("근로자 명부에 들어갑니다");
});

test("a valid hire keeps the existing workplace preview", () => {
  expect(render(false)).toContain("근로자 명부에 들어갑니다");
});
