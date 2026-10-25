import { expect, test } from "vitest";
import { lifecycleBody } from "./use-lifecycle-command";
import { EMPTY } from "./use-lifecycle-draft";

test("future response leave types cannot become unvalidated command values", () => {
  const context = { employeeId: "employee", kind: "LEAVE_OF_ABSENCE" as const, pin: 3 };
  expect(lifecycleBody({ ...EMPTY, leaveType: "FUTURE_LEAVE" }, context).leave_type).toBeUndefined();
  expect(lifecycleBody({ ...EMPTY, leaveType: "WORK_INJURY" }, context).leave_type).toBe("WORK_INJURY");
});

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

test("role and job appointments never submit hidden fields from an older draft", () => {
  const draft = { ...EMPTY, roleId: "role", jobId: "job", familyId: "family" };
  const context = { employeeId: "employee", kind: "APPOINT" as const, pin: 3 };
  const role = lifecycleBody(draft, { ...context, appointMode: "role" });
  expect(role.to_position_kind_id).toBe("role");
  expect(role.to_job_id).toBeUndefined();
  expect(role.to_job_family_id).toBeUndefined();
  const job = lifecycleBody(draft, { ...context, appointMode: "job" });
  expect(job.to_job_id).toBe("job");
  expect(job.to_job_family_id).toBe("family");
  expect(job.to_position_kind_id).toBeUndefined();
});
