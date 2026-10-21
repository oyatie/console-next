import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { apiOf, HERO } from "./universe";

// The hero's working life before the console (employee-ux/final E2: 발령 이력, 직급·직책, 다음 일정), recorded through the
// product's own API under the admin's session: the tenant's 직급·직책·직무·직군 lists, then the dated 발령 in order —
// 승진 2023, 육아휴직 2024-02 ~ 04 and 복직, 전보 생산2팀 → 생산1팀 2024-07, 조장 2025, and 반장 reserved for 11-01.

type Title = { id: string };
const KINDS = [
  ["GRADE", ["사원", "주임", "대리", "과장", "차장", "부장"]],
  ["POSITION", ["조장", "반장"]],
  ["JOB", ["생산·조립 (CNC 가공)"]],
  ["JOB_FAMILY", ["기능직"]],
] as const;

/** The catalogs, or null where the server keeps them closed (job_title_manage before BE-EMP-UI: deny-all writes). */
async function catalogs(call: Awaited<ReturnType<typeof apiOf>>) {
  const ids = new Map<string, string>();
  for (const [kind, labels] of KINDS)
    for (const [i, label] of labels.entries()) {
      const made = await call<Title | null>("post", "/api/v1/job-titles", { data: { kind, label, grade_rank: kind === "GRADE" ? i + 1 : null } }, [200, 201, 403]);
      if (!made?.id) return null;
      ids.set(label, made.id);
    }
  return ids;
}

export async function heroHistory(admin: Page, nextFirst: string) {
  const call = await apiOf(admin);
  const ids = await catalogs(call);
  const hero = (await call<{ items: { id: string }[] }>("get", `/api/v1/employees?search=${HERO.no}`)).items[0]!;
  const units = (await call<{ items: { id: string; name: string }[] }>("get", "/api/v1/org-units")).items;
  const unit = units.find((u) => u.name === "생산1팀")!.id;
  const record = (data: Record<string, unknown> & { comment: string }) =>
    call("post", `/api/v1/employees/${hero.id}/lifecycle-events`, { data, headers: { "Idempotency-Key": randomUUID() } }, [200, 201]);
  await record({ event_type: "PROMOTE", effective_date: "2023-01-01", comment: "2023 정기 승진", reason_code: "REGULAR_PROMOTION", ...(ids ? { to_grade_id: ids.get("주임"), to_position: "주임" } : { to_position: "주임" }) });
  await record({ event_type: "LEAVE_OF_ABSENCE", effective_date: "2024-02-01", comment: "휴직 신청서", leave_type: "CHILDCARE", expected_return_date: "2024-04-30" });
  await record({ event_type: "RETURN_FROM_LEAVE", effective_date: "2024-05-01", comment: "복직 신청서" });
  await record({ event_type: "TRANSFER", effective_date: "2024-07-01", comment: "인력 재배치", reason_code: "REGULAR_RESHUFFLE", to_org_unit_id: unit });
  if (!ids) return;
  await record({ event_type: "APPOINT", effective_date: "2025-01-01", comment: "2025 조직 개편", to_position_kind_id: ids.get("조장"), to_job_id: ids.get("생산·조립 (CNC 가공)"), to_job_family_id: ids.get("기능직") });
  await record({ event_type: "APPOINT", effective_date: nextFirst, comment: "생산1팀 반장 공석 보충", to_position_kind_id: ids.get("반장") });
}
