// Employee identifiers (IMPORT-2, decisions #25): the employee number, its change history and numbering rules, bulk
// renumbering in SETUP, and the resident registration number (masked; revealed once, with a reason).
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../lib/query";
import { employeeRecord, pinned } from "../../lib/record-versions";

type S = components["schemas"];
export type NumberChange = S["EmployeeNumberChange"];
export type NumberChangeRequest = S["EmployeeNumberChangeRequest"];
export type NumberRule = S["EmployeeNumberRule"];
export type NumberRuleRequest = S["EmployeeNumberRuleRequest"];
export type ScopeKind = NumberRule["scope_kind"];
export type RenumberRequest = S["EmployeeRenumberRequest"];
export type RenumberPreview = S["EmployeeRenumberPreview"];
export type RenumberLine = RenumberPreview["lines"][number];
export type RenumberResult = S["EmployeeRenumberResult"];
export type RrnStatus = S["EmployeeRrnStatus"];

/** The most a employee number may hold (EmployeeNumberChangeRequest.new_number), and a note. */
export const NUMBER_MAX = 40;
export const NOTE_MAX = 1000;

export const employeeRef = (id: string) => get("/api/v1/employees/{id}", { params: { path: { id } } });
export const historyQuery = (id: string) => get("/api/v1/employees/{id}/employee-number/history", { params: { path: { id } } });
export const rrnQuery = (id: string) => get("/api/v1/employees/{id}/rrn", { params: { path: { id } } });
export const rulesQuery = get("/api/v1/employee-number-rules");

/** A dated number change at the version read, past this tab's own writes to other fields (lib/record-versions). */
export const changeNumber = (id: string, body: NumberChangeRequest) =>
  pinned(employeeRecord(id), body.expected_updated_at, ["employee_number"], (at) =>
    unwrap(api.POST("/api/v1/employees/{id}/employee-number", { params: { path: { id } }, body: { ...body, expected_updated_at: at } })));
/** The full number, once: never cached (the caller's command forgets it), never stored. */
export const revealRrn = (id: string, reason: { code: string; note: string }) =>
  unwrap(api.POST("/api/v1/employees/{id}/rrn/reveal", { params: { path: { id } }, body: { reason_code: reason.code, ...(reason.note ? { note: reason.note } : {}) } }));

export const setRule = (body: NumberRuleRequest) => unwrap(api.PUT("/api/v1/employee-number-rules", { body }));
export const removeRule = (scope_kind: ScopeKind, scope_id?: string) =>
  unwrap(api.DELETE("/api/v1/employee-number-rules", { params: { query: { scope_kind, ...(scope_id ? { scope_id } : {}) } } }));

export const renumberPreview = (body: RenumberRequest) => unwrap(api.POST("/api/v1/employees/renumber/preview", { body }));
export const renumberApply = (request: RenumberRequest, preview_digest: string) =>
  unwrap(api.POST("/api/v1/employees/renumber/apply", { body: { request, preview_digest } }));
export const renumberUndo = (batch_id: string) => unwrap(api.POST("/api/v1/employees/renumber/{batch_id}/undo", { params: { path: { batch_id } } }));
