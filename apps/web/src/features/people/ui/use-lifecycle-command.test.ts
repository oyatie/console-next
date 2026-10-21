import { expect, test } from "vitest";
import { lifecycleBody } from "./use-lifecycle-command";
import { EMPTY } from "./use-lifecycle-draft";

test("promotions independently send grade and title ids; grade-only keeps the position", () => {
  const context = { employeeId: "employee", kind: "PROMOTE" as const, pin: 3 };
  const grade = lifecycleBody({ ...EMPTY, gradeId: "grade", date: "2026-10-12" }, context);
  expect(grade.to_grade_id).toBe("grade");
  expect(grade.to_job_title_id).toBeUndefined();
  expect(grade.to_position).toBeUndefined();
  const both = lifecycleBody({ ...EMPTY, gradeId: "grade", titleId: "title", position: "Senior" }, context);
  expect(both.to_grade_id).toBe("grade");
  expect(both.to_job_title_id).toBe("title");
  expect(both.to_position).toBeUndefined();
  const appoint = lifecycleBody({ ...EMPTY, gradeId: "grade", roleId: "role" }, { ...context, kind: "APPOINT" });
  expect(appoint.to_grade_id).toBeUndefined();
  expect(appoint.to_position_kind_id).toBe("role");
});
