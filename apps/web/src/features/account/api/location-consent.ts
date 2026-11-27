// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../../lib/query";

export type LocationConsentStatus = components["schemas"]["LocationConsentStatus"];
export type LocationConsentState = components["schemas"]["LocationConsentState"];

export const locationConsentStatusQuery = get("/api/v1/location-consent/status");

export function grantLocationConsent(branchId?: string) {
  return unwrap(api.POST("/api/v1/location-consent/grant", { body: branchId ? { branch_id: branchId } : {} }));
}

export function suspendLocationConsent(branchId?: string) {
  return unwrap(api.POST("/api/v1/location-consent/suspend", { body: branchId ? { branch_id: branchId } : {} }));
}

export function resumeLocationConsent(branchId?: string) {
  return unwrap(api.POST("/api/v1/location-consent/resume", { body: branchId ? { branch_id: branchId } : {} }));
}

export function withdrawLocationConsent(branchId?: string) {
  return unwrap(api.POST("/api/v1/location-consent/withdraw", { body: branchId ? { branch_id: branchId } : {} }));
}
