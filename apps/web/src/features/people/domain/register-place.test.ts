// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { resolvePlace, type PlaceOption } from "./register-place";

test("registration uses the server's first permitted placement date, including for a picked workplace", () => {
  const entity = { id: "entity", current: { name: "법인", effective_from: "2026-10-24" }, workplaces: [{ id: "workplace", default_branch_id: "branch", placement_opens_on: "2020-03-02", current: { name: "본사", effective_from: "2026-10-24" } }] } as unknown as components["schemas"]["LegalEntity"];
  const place = { unit: { id: "unit" }, workplaceId: "workplace" } as PlaceOption;
  expect(resolvePlace(place, [entity], "")?.opensOn).toBe("2020-03-02");
  expect(resolvePlace({ ...place, workplaceId: null }, [entity], "workplace")?.opensOn).toBe("2020-03-02");
});
