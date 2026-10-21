import type { components, paths } from "@console/api/schema";
type BulkRequest = components["schemas"]["BulkEmployeeLifecycleEventRequest"];
type LineDraft = paths["/api/v1/change-sets/{id}/lines"]["post"]["requestBody"]["content"]["application/json"];

/** The batches' people as change-set lines (one per employee; the batch's target on each). */
export const linesOf = (batches: readonly BulkRequest[]): LineDraft[] =>
  batches.flatMap((b) =>
    (b.employee_ids ?? []).map((employee_id) => ({
      employee_id,
      effective_date: b.effective_date,
      to_org_unit_id: b.to_org_unit_id ?? undefined,
      to_position: b.to_position ?? undefined,
      to_job_title_id: b.to_job_title_id ?? undefined,
      to_grade_id: b.to_grade_id ?? undefined,
      reason_code: b.reason_code ?? undefined,
      comment: b.comment,
    })),
  );

