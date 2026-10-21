import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import { peopleRefusal } from "./present";

beforeAll(() => loadCatalog("ko"));

// UX-R1 PLACEMENT: each refusal that keeps 법인 · 사업장 · 부서 in step names the way forward.
test("placement refusals are worded with their remedy; other codes fall through", () => {
  expect(peopleRefusal("entity_change_needs_group_transfer")).toContain("전적");
  expect(peopleRefusal("org_unit_at_other_workplace")).toContain("전보");
  expect(peopleRefusal("home_branch_not_workplace")).toContain("전보");
  expect(peopleRefusal("lifecycle_noop")).toBeUndefined();
});
