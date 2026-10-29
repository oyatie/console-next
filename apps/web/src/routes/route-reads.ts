// SPDX-License-Identifier: LicenseRef-Proprietary
import { operationAccess } from "../reference/authz/domain/operation-access";
import type { Requirement } from "../reference/authz/domain/access";

import { pendingPayrollReads } from "./pending-payroll-reads";
const readAccess = { ...operationAccess, ...pendingPayrollReads };
type Operation = keyof typeof readAccess;
type Reads = { reads: readonly Operation[]; command?: Operation };
const structure = "GET /api/v1/org-structure";
const entities = "GET /api/v1/legal-entities";
const units = "GET /api/v1/org-units";
const people = "GET /api/v1/employees";
const roles = "GET /api/v1/access/roles";
const orgDraft = "POST /api/v1/org-changes";
const appointment = "POST /api/v1/employees/lifecycle-events/bulk/preview";
const register = "POST /api/v1/employees";

/** Required first reads (including default tabs), plus the server door a form offers. No permission alternatives. */
export const routeReads = {
  "/access": { reads: [roles] },
  "/access/roles": { reads: [roles] },
  "/access/roles/$roleId": { reads: ["GET /api/v1/access/roles/{roleId}"] },
  "/access/roles/new": { reads: [roles], command: "POST /api/v1/access/roles" },
  "/access/grants": { reads: ["GET /api/v1/access/grants"] },
  "/access/grants/bulk": { reads: [roles], command: "POST /api/v1/access/grants/preview" },
  "/access/people/$accountId": { reads: ["GET /api/v1/access/accounts/{accountId}/effective"] },
  "/access/ready": { reads: ["GET /api/v1/access/grants"] },
  "/attendance": { reads: ["GET /api/v1/attendance/month", "GET /api/v1/attendance/days", "GET /api/v1/attendance/schedule/tree"] },
  "/org": { reads: [structure] },
  "/org/entities": { reads: [entities] },
  "/org/entities/new": { reads: [entities], command: "POST /api/v1/legal-entities" },
  "/org/entities/bulk": { reads: [entities], command: "POST /api/v1/legal-entities" },
  "/org/entities/$id/workplaces/new": { reads: [structure], command: orgDraft },
  "/org/changes": { reads: ["GET /api/v1/org-changes"] },
  "/org/history": { reads: ["GET /api/v1/org-structure/batches", "GET /api/v1/entity-setup/batches", "GET /api/v1/org-changes", structure] },
  "/org/move": { reads: [structure], command: orgDraft },
  "/org/paste": { reads: [structure], command: orgDraft },
  "/org/import": { reads: [structure], command: orgDraft },
  "/org/workplaces/edit": { reads: [structure, entities], command: orgDraft },
  "/setup/org": { reads: [structure] },
  "/setup/company-names": { reads: [entities] },
  "/setup/go-live": { reads: ["GET /api/v1/onboarding/go-live/preview"] },
  "/settings/company-domain": { reads: ["GET /api/v1/tenant/company-domain/request"] },
  "/people": { reads: [people, "GET /api/v1/directory/people"] },
  "/people/new": { reads: [people, units, entities, structure], command: register },
  "/people/run": { reads: [units, entities, structure], command: register },
  "/people/grid": { reads: [people, units, entities, structure], command: register },
  "/people/bulk": { reads: [people, units, entities, structure], command: appointment },
  "/people/renew": { reads: [people], command: appointment },
  "/people/numbering": { reads: ["GET /api/v1/employee-number-rules"], command: "PUT /api/v1/employee-number-rules" },
  "/people/notices": { reads: ["GET /api/v1/appointment-notices"] },
  "/people/notices/new": { reads: ["GET /api/v1/appointment-notices/candidates"] },
  "/people/import": { reads: ["GET /api/v1/employees/import/unplaced"] },
  "/people/unplaced": { reads: ["GET /api/v1/employees/import/unplaced"] },
  "/people/job-titles": { reads: ["GET /api/v1/job-titles"] },
  "/people/certificates": { reads: ["GET /api/v1/hr/certificates"] },
  "/people/exits": { reads: ["GET /api/v1/hr/exit-cases"] },
  "/people/period-locks": { reads: ["GET /api/v1/period-locks"] },
  "/payroll": { reads: ["GET /api/v1/payroll/pay-groups", "GET /api/v1/payroll/runs"] },
  "/payroll/reference": { reads: ["GET /api/v1/payroll/pay-groups", "GET /api/v1/payroll/reference/rates"] },
  "/statutory": { reads: ["GET /api/v1/statutory/workplaces"] },
} as const satisfies Record<string, Reads>;

export function readRequirement(path: keyof typeof routeReads): Requirement | { allOf: readonly Requirement[] } {
  const { reads, command } = routeReads[path] as Reads;
  const needs: Requirement[] = [...reads, ...(command ? [command] : [])].map(op => readAccess[op]);
  const allOf = needs.filter((need, i) => needs.findIndex(other => JSON.stringify(other) === JSON.stringify(need)) === i);
  return allOf.length === 1 ? allOf[0]! : { allOf };
}
