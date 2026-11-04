// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api";
import type { Page } from "@playwright/test";
import { id, screenAccess } from "./fixtures";
import { mockRoute } from "./route";

export const certificateSettings: components["schemas"]["CertificateSettings"] = {
  legal_entity_id: id(4001), prefix: "HR", width: 4, seal_text: "화면 검증 회사 대표", seal_png: null, version: 3,
};
export async function certificateAccess(page: Page, allowed: boolean | undefined) {
  const access = screenAccess("/people/certificates");
  const json = { ...access, decisions: { ...access.decisions, certificate_settings_manage: allowed } };
  await mockRoute(page, "get", "/api/v1/access/me", { status: 200, json });
}
