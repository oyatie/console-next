// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
import { routeAccess } from "./route-operation-access";
export { routeReads } from "./route-read-data";

/** Served routes require their own server permission decision before the register reads. */
export const servedRouteReads = {
  "/consulting": { access: { servedCapability: "served_consulting" }, reads: ["/api/v1/consulting/engagements"] },
  "/consulting/engagements/$engagementId": { access: { servedCapability: "served_consulting" }, reads: ["/api/v1/consulting/engagements/{engagement_id}", "/api/v1/consulting/engagements/{engagement_id}/history"] },
  "/calendar": { access: { servedCapability: "served_calendar" }, reads: ["/api/v1/collaboration/calendar/events"] },
  "/benefits": { access: { servedCapability: "served_benefit_catalog" }, reads: ["/api/v1/benefit-catalog/items"] },
  "/evaluation": { access: { servedCapability: "served_evaluation_cycles" }, reads: ["/api/v1/evaluation/cycles"] },
  "/evaluation/new": { access: { servedCapability: "served_evaluation_cycle_create" }, reads: ["/api/v1/me/authz"] },
  "/me/evaluations": { access: { servedCapability: "served_evaluation_tasks" }, reads: ["/api/v1/evaluation/my-tasks"] },
  "/audit/location-consents": { access: { servedCapability: "served_location_consent_ledger" }, reads: ["/api/v1/location-consents/ledger"] },
  "/audit/findings": { access: { servedCapability: "served_integrity_findings" }, reads: ["/api/v1/integrity/findings"] },
  "/audit/evidence": { access: { servedCapability: "documents" }, reads: ["/api/v1/evidence/objects"] },
} as const;

export function readRequirement(path: keyof typeof routeAccess): Requirement | { allOf: readonly Requirement[] } {
  return routeAccess[path];
}
