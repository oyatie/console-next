import { expect, test } from "vitest";
import { linesOf } from "./bulk-lines";

test("a bulk promotion keeps its catalog ID through change-set drafting", () => {
  const lines = linesOf([{ event_type: "PROMOTE", employee_ids: ["one", "two"], to_position: "Senior", to_job_title_id: "senior", to_grade_id: "grade", effective_date: "2026-10-12", reason_code: "REGULAR_PROMOTION", comment: "Review" }]);
  expect(lines.map((l) => [l.employee_id, l.to_job_title_id, l.to_grade_id, l.to_position])).toEqual([["one", "senior", "grade", "Senior"], ["two", "senior", "grade", "Senior"]]);
});
