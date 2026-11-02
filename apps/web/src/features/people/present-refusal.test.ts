import { beforeAll, expect, test } from "vitest";
import { i18n, loadCatalog } from "@console/i18n";
import { ApiError } from "@console/api";
import { failureText, readFailureText } from "../../lib/refusal";
import { lifecycleTrailError, peopleRefusal } from "./present";

beforeAll(() => loadCatalog("ko"));

// UX-R1 PLACEMENT: each refusal that keeps 법인 · 사업장 · 부서 in step names the way forward.
test("placement refusals are worded with their remedy; other codes fall through", () => {
  expect(peopleRefusal("entity_change_needs_group_transfer")).toContain("전적");
  expect(peopleRefusal("org_unit_at_other_workplace")).toContain("전보");
  expect(peopleRefusal("home_branch_not_workplace")).toContain("전보");
  expect(peopleRefusal("lifecycle_noop")).toBeUndefined();
});

test.each(["ko", "en"] as const)("served lifecycle refusals have actionable %s copy", async (locale) => {
  await loadCatalog(locale);
  i18n.set(locale);
  try {
    for (const code of ["lifecycle.refuse.close_blocked", "lifecycle.refuse.withdrawn", "lifecycle.refuse.stale_version", "lifecycle.refuse.merge_not_allowed"]) {
      const text = lifecycleTrailError(code);
      expect(text, code).toBeDefined();
      expect(text).not.toBe(code);
      expect(text?.trim()).not.toBe("");
      const error = new ApiError(409, code, "internal basis", [], undefined, true);
      expect(failureText(error)).toBe(text);
      expect(readFailureText(error)).toBe(text);
      expect(failureText(error, () => "")).toBe(text);
      expect(failureText(error, () => "specific remedy")).toBe("specific remedy");
    }
    expect(lifecycleTrailError("lifecycle.refuse.unknown")).toBeUndefined();
    expect(lifecycleTrailError("lifecycle.trail.title")).toBeUndefined();
  } finally { i18n.set("ko"); }
});
