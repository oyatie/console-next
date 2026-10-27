// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { paths } from "@console/api";
import { failure, id, LONG_NAME } from "../mock/fixtures";
import { mockRoute } from "../mock/route";
import { mockScreen } from "../mock/screen";
import { brnDisplay, REGISTRATION_FIXTURES } from "../setup-flows";
import { screens } from "./registry";

type Entity = paths["/api/v1/legal-entities/{entityId}"]["get"]["responses"][200]["content"]["application/json"];
export const entityRecordStates = ["populated", "long", "loading", "failed", "refused", "missing"] as const;
type EntityRecordState = typeof entityRecordStates[number];
export const entityRecordPath = `/org/entities/${id(4100)}`;

function entityRecord(state: EntityRecordState): Entity {
  const workers: Entity["regular_workers"] = { status: "HOLD", value: null, basis: "LSA_DECREE_7_2", missing: [], live_headcount: 0 };
  return {
    id: id(4100), biz_kind: "CORPORATION", can_manage: true, founding: false, identity_locked: false, needs_confirmation: false,
    head_office_has_no_workplace: false, identity_problems: [], name_reviews: [], scheduled: [], regular_workers: workers,
    current: { version: 1, effective_from: "2026-01-01", before_first_record: false, change_mode: "SETUP", name: state === "long" ? LONG_NAME.repeat(3) : "주식회사 검증법인", representatives: ["김대표", "이대표"], directors: [], additional_representatives: 0 },
    registrations: [{ id: id(4101), legal_entity_id: id(4100), verification_tier: "NONE", needs_confirmation: false, identity_locked: false,
      brn: { value: REGISTRATION_FIXTURES.primary.brn, display: brnDisplay(REGISTRATION_FIXTURES.primary.brn) }, current: null }],
    workplaces: [{ id: id(4102), legal_entity_id: id(4100), registration_id: id(4101), registration_todo: false,
      is_primary: true, is_head_office: true, needs_confirmation: false, can_manage: true,
      headcount: 0, insurance: [], withholding: { kind: "SELF_UNIT" }, regular_workers: workers,
      current: { version: 1, effective_from: "2026-01-01", before_first_record: false, name: state === "long" ? LONG_NAME.repeat(3) : "검증 본사", is_construction_site: false, status: "CONTINUING", change_mode: "SETUP" } }],
  };
}

export async function mockEntityRecord(page: Page, state: EntityRecordState) {
  // shortcut: reuse the org shell until UI-DECOUPLE adds this record to the shared Screen union.
  const shell = await mockScreen(page, screens[2], "populated");
  const entity = entityRecord(state);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}", async () => {
    if (state === "loading") await held;
    if (state === "failed") return { status: 503, json: failure("service_unavailable") };
    if (state === "refused") return { status: 403, json: failure("forbidden") };
    if (state === "missing") return { status: 404, json: failure("not_found") };
    return { status: 200, json: entity };
  });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/documents", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/revisions", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/workplaces/{workplaceId}/revisions", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/business-registrations/{registrationId}/revisions", { status: 200, json: { items: [] } });
  await mockRoute(page, "get", "/api/v1/legal-entities/{entityId}/end-options", { status: 200, json: { id: entity.id, phase: "OPERATING", can_manage: true, delete: { allowed: false, refusal: "entity_in_use" }, close: { allowed: true }, open_exit_cases: [] } });
  await mockRoute(page, "get", "/api/v1/business-registrations/{registrationId}/checks", { status: 200, json: { items: [], latest_status: null, latest_validate: null, availability: { available: false, reason: "NOT_CONFIGURED" } } });
  return { ...shell, entity, operationId: id(99), release: () => { release(); shell.release(); } };
}
