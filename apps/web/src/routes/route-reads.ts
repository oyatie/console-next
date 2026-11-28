// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
import { routeAccess } from "./route-operation-access";
export { overtimeReadAccess } from "./route-operation-access";
export { alternativeRouteReads, routeReads } from "./route-read-data";

/** Served routes require their own server permission decision before the register reads. */
export const servedRouteReads = {
  "/compliance": { access: { servedCapability: "served_compliance_catalog" }, reads: ["/api/v1/compliance/frameworks", "/api/v1/compliance/obligations"] },
  "/compliance/new": { access: { servedCapability: "served_compliance_catalog_manage" }, reads: ["/api/v1/me/authz"] },
  "/payroll/outlook": { access: { servedCapability: "analytics_projection" }, reads: ["/api/v1/analytics/projection"], method: "post" },
  "/audit/lifecycles/$objectType/$objectId": { access: { servedCapability: "lifecycle_manage" }, reads: ["/api/v1/lifecycles/{objectType}/{objectId}"] },
  "/evaluation": { access: { servedCapability: "served_evaluation_cycles" }, reads: ["/api/v1/evaluation/cycles"] },
  "/evaluation/new": { access: { servedCapability: "served_evaluation_cycle_create" }, reads: ["/api/v1/me/authz"] },
  "/me/evaluations": { access: { servedCapability: "served_evaluation_tasks" }, reads: ["/api/v1/evaluation/my-tasks"] },
  "/audit/restricted": { access: { servedCapability: "restricted_audit_stream" }, reads: ["/api/v1/audit-streams/ceo-covert/events", "/api/v1/audit-streams/ceo-covert/access-events"] },
  "/calendar": { access: { servedCapability: "served_calendar" }, reads: ["/api/v1/collaboration/calendar/events"] },
  "/benefits": { access: { servedCapability: "served_benefit_catalog" }, reads: ["/api/v1/benefit-catalog/items"] },
  "/audit/location-consents": { access: { servedCapability: "served_location_consent_ledger" }, reads: ["/api/v1/location-consents/ledger"] },
  "/audit/findings": { access: { servedCapability: "served_integrity_findings" }, reads: ["/api/v1/integrity/findings"] },
  "/audit/evidence": { access: { servedCapability: "documents" }, reads: ["/api/v1/evidence/objects"] },
} as const;

export function readRequirement(path: keyof typeof routeAccess): Requirement | { allOf: readonly Requirement[] } {
  return routeAccess[path];
}
