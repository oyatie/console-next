// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components } from "@console/api";
import { get } from "../../lib/query";
export { ApiError, assertSettingsChangeStepUp } from "@console/api";

/** The tenant settings in force; screens read `approval.policy.<class>` and `display.experience` from it. */
export const settingsQuery = { ...get("/api/v1/settings"), staleTime: 5 * 60_000 };

/** Effective settings evaluated at a specific legal entity or workplace scope (`GET /api/v1/settings?entity=`). */
export const settingsForEntityQuery = (entityId?: string | null) =>
  entityId
    ? { ...get("/api/v1/settings", { params: { query: { entity: entityId } } }), retry: false }
    : settingsQuery;

/** Dry-run change preview returning `SettingChangePlan` (direction, step-up, delay, descendant overrides). */
export const planSetting = (key: string, body: components["schemas"]["SettingChangeRequest"]) =>
  unwrap(api.POST("/api/v1/settings/{key}", { params: { path: { key }, query: { dry_run: true } }, body })) as Promise<components["schemas"]["SettingChangePlan"]>;

export const changeSetting = (key: string, body: components["schemas"]["SettingChangeRequest"]) =>
  unwrap(api.POST("/api/v1/settings/{key}", { params: { path: { key } }, body })) as Promise<components["schemas"]["SettingChange"]>;

/** Setting override history; backend returns 403 until `PolicyConfigView` is enabled so callers disable retry. */
export const settingHistoryQuery = (key: string) =>
  ({ ...get("/api/v1/settings/{key}/history", { params: { path: { key } } }), retry: false });

export const addReasonCode = (body: components["schemas"]["ReasonCodeAddRequest"]) =>
  unwrap(api.POST("/api/v1/reason-codes", { body }));

export const updateReasonCode = (domain: string, code: string, body: components["schemas"]["ReasonCodeUpdateRequest"]) =>
  unwrap(api.PATCH("/api/v1/reason-codes/{domain}/{code}", { params: { path: { domain, code } }, body }));
