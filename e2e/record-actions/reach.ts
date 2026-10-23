// Where each Org/HR record's create, update/correct and end action is found (docs/design/record-actions.md §6): the record's
// own page, then at most two interactions, each a control found by role and accessible name, the last being the action.
// Read by scripts/check-reach.mjs (every record type in docs/product/record-lifecycle.json with a backend operation is
// registered here or listed in scripts/reach-baseline.json) and walked by e2e/record-actions/reach.spec.ts (this file sits beside it).
// Pure data, no imports: Node reads it with type stripping.
//
// Names may hold the world's placeholders: {person}, {company}, {workplace}, {dept}, {contact}, {school}, {career}.

/** One interaction: a control by role and accessible name (`prefix`: the name starts with it, as the org chart's nodes do). */
/** `any`: the name is one of several "a|b" (the server decides which verb applies: 삭제 while unused, 폐지 once used). */
export type ReachStep = { role: "button" | "link" | "menuitem" | "treeitem"; name: string; exact?: boolean; prefix?: boolean; any?: boolean; within?: string };
/** The record's own page (a route in the world): its list, its record page or the org chart. */
export type ReachPage = "people" | "card" | "entities" | "entity" | "chart";
type ReachOp = "create" | "update" | "end";
/** `phase` limits an entry to the setup phase (삭제 while nothing depends on it) or a live tenant (the governed verb). */
export type ReachEntry = { record: string; op: ReachOp; page: ReachPage; via: readonly ReachStep[]; phase?: "setup" | "live" };

const b = (name: string, more: Partial<ReachStep> = {}): ReachStep => ({ role: "button", name, ...more });
const node = (name: string): ReachStep => ({ role: "treeitem", name, prefix: true });

export const REACH: readonly ReachEntry[] = [
  // 법인
  { record: "Entity.legal_entity", op: "create", page: "entities", via: [{ role: "link", name: "법인 추가" }] },
  { record: "Entity.legal_entity", op: "update", page: "entity", via: [b("대표전화 수정", { exact: true })] },
  { record: "Entity.legal_entity", op: "end", page: "entity", via: [b("법인 삭제 미리보기|법인 종료 계획 보기", { any: true })] },
  { record: "Entity.business_registration", op: "end", page: "entity", via: [b("사업자등록증(?: · 본점)? .+ 더보기", { any: true }), { role: "menuitem", name: "삭제", exact: true }], phase: "setup" },
  // 사업장: the same fact rows on the 법인 page's panel and the org chart's (owner: 「사업장 이름은 어떻게 수정해?」)
  { record: "Entity.workplace", op: "create", page: "entity", via: [{ role: "link", name: "사업장 추가" }] },
  { record: "Entity.workplace", op: "update", page: "entity", via: [b("사업장 1", { prefix: true }), b("사업장 이름 수정", { exact: true, within: "{workplace}" })] },
  { record: "Entity.workplace", op: "update", page: "chart", via: [node("{workplace}"), b("사업장 이름 수정", { exact: true })] },
  { record: "Entity.workplace", op: "end", page: "chart", via: [node("{workplace}"), b("사업장 삭제|사업장 폐쇄", { any: true })] },
  // 부서
  { record: "Org.org_unit", op: "create", page: "chart", via: [node("{workplace}"), b("부서 추가", { exact: true })] },
  { record: "Org.org_unit", op: "update", page: "chart", via: [node("{dept}"), b("부서 이름 수정", { exact: true })] },
  { record: "Org.org_unit", op: "end", page: "chart", via: [node("{dept}"), b("부서 삭제|부서 폐지", { any: true })] },
  // 직원 (인사카드)
  { record: "HR.employee", op: "create", page: "people", via: [{ role: "link", name: "직원 등록", exact: true }] },
  { record: "HR.employee", op: "update", page: "card", via: [b("성명 수정", { exact: true })] },
  { record: "HR.employee", op: "end", page: "card", via: [b("퇴직", { exact: true })] },
  { record: "HR.employee.address", op: "create", page: "card", via: [b("주소 수정", { exact: true })] },
  { record: "HR.employee.address", op: "update", page: "card", via: [b("주소 수정", { exact: true })] },
  { record: "HR.employee.career", op: "create", page: "card", via: [b("경력 추가", { exact: true })] },
  { record: "HR.employee.career", op: "update", page: "card", via: [b("{career} 수정", { exact: true })] },
  { record: "HR.employee.career", op: "end", page: "card", via: [b("{career} 더보기", { exact: true }), { role: "menuitem", name: "삭제" }], phase: "setup" },
  { record: "HR.employee.career", op: "end", page: "card", via: [b("{career} 더보기", { exact: true }), { role: "menuitem", name: "무효화" }], phase: "live" },
  { record: "HR.employee.emergency_contact", op: "create", page: "card", via: [b("비상연락처 추가", { exact: true })] },
  { record: "HR.employee.emergency_contact", op: "update", page: "card", via: [b("비상연락처 {contact} 수정", { exact: true })] },
  { record: "HR.employee.emergency_contact", op: "end", page: "card", via: [b("비상연락처 {contact} 더보기", { exact: true }), { role: "menuitem", name: "삭제" }], phase: "setup" },
  { record: "HR.employee.emergency_contact", op: "end", page: "card", via: [b("비상연락처 {contact} 더보기", { exact: true }), { role: "menuitem", name: "무효화" }], phase: "live" },
  { record: "HR.employee_photo", op: "create", page: "card", via: [b("사진 추가", { exact: true })] },
  { record: "HR.record_section", op: "create", page: "card", via: [b("학력 추가", { exact: true })] },
  { record: "HR.record_section", op: "update", page: "card", via: [b("{school} 수정", { exact: true })] },
  { record: "HR.record_section", op: "end", page: "card", via: [b("{school} 더보기", { exact: true }), { role: "menuitem", name: "무효화" }] },
  { record: "HR.employee_number", op: "create", page: "card", via: [b("사번 변경", { exact: true })] },
  { record: "HR.employee_number", op: "update", page: "card", via: [b("사번 수정", { exact: true })] },
  { record: "HR.employment_profile", op: "create", page: "card", via: [b("고용형태 수정", { exact: true })] },
  { record: "HR.employment_profile", op: "update", page: "card", via: [b("고용형태 수정", { exact: true })] },
  { record: "HR.employment", op: "create", page: "people", via: [{ role: "link", name: "직원 등록", exact: true }] },
  { record: "HR.employment", op: "update", page: "card", via: [b("발령", { exact: true })] },
  { record: "HR.employment", op: "end", page: "card", via: [b("퇴직", { exact: true })] },
  { record: "HR.lifecycle_event", op: "create", page: "card", via: [b("발령", { exact: true })] },
  { record: "HR.exit_case", op: "create", page: "card", via: [b("퇴직", { exact: true })] },
];
