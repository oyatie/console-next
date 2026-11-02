// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import { mockRoute } from "./route";

export const contractWindowSettings = (days: number) => ({ can_change: false, items: [{
  key: "hr.contract_soon_days", kind: { type: "int" as const }, default: days, value: days,
  looser_when: "higher" as const, governance: "tenant" as const, legal_basis: null, version: "code_default" as const, effective_from: null, scheduled: [],
  source: { layer: "code_default" as const, scope_entity_id: null }, chain: [],
}] });

export const mockDirectorySettings = (page: Page) => mockRoute(page, "get", "/api/v1/settings", { status: 200, json: contractWindowSettings(60) });
