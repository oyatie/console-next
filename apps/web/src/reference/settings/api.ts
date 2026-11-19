// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components } from "@console/api";
import { get } from "../../lib/query";

/** The tenant settings in force; screens read `approval.policy.<class>` and `display.experience` from it. */
export const settingsQuery = { ...get("/api/v1/settings"), staleTime: 5 * 60_000 };

export const changeSetting = (key: string, body: components["schemas"]["SettingChangeRequest"]) =>
  unwrap(api.POST("/api/v1/settings/{key}", { params: { path: { key } }, body }));
