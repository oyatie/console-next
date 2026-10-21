import { expect, test } from "vitest";
import { bulkDemotion, bulkPromotion } from "./bulk-promotion";
import type { JobTitle } from "./titles";

const titles: JobTitle[] = [
  { id: "junior", kind: "TITLE", label: "Junior", grade_rank: 1, active: true },
  { id: "senior", kind: "TITLE", label: "Senior", grade_rank: 2, active: true },
  { id: "inactive", kind: "TITLE", label: "Retired", grade_rank: 3, active: false },
  { id: "grade", kind: "GRADE", label: "Grade", grade_rank: 4, active: true },
];
test.each(["junior", "Junior"])("bulk catalog promotion %s preserves its ID", (target) => {
  expect(bulkPromotion(target, titles)).toEqual({ to_job_title_id: "junior", to_position: "Junior" });
});
test.each(["Retired", "inactive", "Grade", "missing"])("%s cannot clear a catalog title", (target) => {
  expect(bulkPromotion(target, titles)).toBeNull();
});
test("an empty TITLE list allows free text; demotion compares ranks", () => {
  expect(bulkPromotion(" New title ", [titles[3]!])).toEqual({ to_position: "New title" });
  expect(bulkDemotion("Senior", "junior", titles)).toBe(true);
  expect(bulkDemotion("Junior", "senior", titles)).toBe(false);
});
