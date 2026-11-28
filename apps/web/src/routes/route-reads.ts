// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
import { routeAccess } from "./route-operation-access";
export { overtimeReadAccess } from "./route-operation-access";
export { alternativeRouteReads, routeReads } from "./route-read-data";

/** Served routes require their own server permission decision before the register reads. */
export const servedRouteAccess = {
  "/payroll/outlook": { servedCapability: "analytics_projection" },
  "/audit/lifecycles/$objectType/$objectId": { servedCapability: "lifecycle_manage" },
  "/consulting": { servedCapability: "served_consulting_entry" },
  "/consulting/engagements/$engagementId": { servedCapability: "served_consulting" },
  "/evaluation": { servedCapability: "served_evaluation_cycles" },
  "/evaluation/new": { servedCapability: "served_evaluation_cycle_create" },
  "/me/evaluations": { servedCapability: "served_evaluation_tasks" },
  "/audit/restricted": { servedCapability: "restricted_audit_stream" },
  "/calendar": { servedCapability: "served_calendar" },
  "/benefits": { servedCapability: "served_benefit_catalog" },
  "/audit/location-consents": { servedCapability: "served_location_consent_ledger" },
  "/audit/findings": { servedCapability: "served_integrity_findings" },
  "/audit/evidence": { servedCapability: "documents" },
} as const;

/** Request inventory for route verification; the browser only needs the admission map. */
export const servedRouteReads = {
  "/payroll/outlook": { access: servedRouteAccess["/payroll/outlook"], reads: ["/api/v1/analytics/projection"], method: "post" },
  "/audit/lifecycles/$objectType/$objectId": { access: servedRouteAccess["/audit/lifecycles/$objectType/$objectId"], reads: ["/api/v1/lifecycles/{objectType}/{objectId}"] },
  "/consulting": { access: servedRouteAccess["/consulting"], reads: ["/api/v1/consulting/engagements"] },
  "/consulting/engagements/$engagementId": { access: servedRouteAccess["/consulting/engagements/$engagementId"], reads: ["/api/v1/consulting/engagements/{engagement_id}", "/api/v1/consulting/engagements/{engagement_id}/history"] },
  "/evaluation": { access: servedRouteAccess["/evaluation"], reads: ["/api/v1/evaluation/cycles"] },
  "/evaluation/new": { access: servedRouteAccess["/evaluation/new"], reads: ["/api/v1/me/authz"] },
  "/me/evaluations": { access: servedRouteAccess["/me/evaluations"], reads: ["/api/v1/evaluation/my-tasks"] },
  "/audit/restricted": { access: servedRouteAccess["/audit/restricted"], reads: ["/api/v1/audit-streams/ceo-covert/events", "/api/v1/audit-streams/ceo-covert/access-events"] },
  "/calendar": { access: servedRouteAccess["/calendar"], reads: ["/api/v1/collaboration/calendar/events"] },
  "/benefits": { access: servedRouteAccess["/benefits"], reads: ["/api/v1/benefit-catalog/items"] },
  "/audit/location-consents": { access: servedRouteAccess["/audit/location-consents"], reads: ["/api/v1/location-consents/ledger"] },
  "/audit/findings": { access: servedRouteAccess["/audit/findings"], reads: ["/api/v1/integrity/findings"] },
  "/audit/evidence": { access: servedRouteAccess["/audit/evidence"], reads: ["/api/v1/evidence/objects"] },
} as const;

export function readRequirement(path: keyof typeof routeAccess): Requirement | { allOf: readonly Requirement[] } {
  return routeAccess[path];
}
