// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { emptyDraft } from "../domain/draft";
import type { EntitySetupItem } from "@console/api/pending";
import { BulkEntityRow } from "./bulk-entity-row";

const inputs = vi.hoisted(() => new Map<string, { value: string; onChange: (event: { target: { value: string } }) => void }>());
vi.mock("../../../ui/field/field", async (original) => {
  const actual = await original<typeof import("../../../ui/field/field")>();
  return { ...actual, TextInput: (props: { value: string; onChange: (event: { target: { value: string } }) => void }) => {
    inputs.set(props.value, props); return <actual.TextInput {...props} />;
  } };
});

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));

beforeAll(() => loadCatalog("ko"));

const renderRow = (element: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{element}</QueryClientProvider>);
};

test("entity facts are locked while their digest is being previewed or applied", () => {
  const row = {
    line: 2,
    draft: { ...emptyDraft(), name: "Example", bizKind: "INDIVIDUAL" as const, representatives: ["Kim"] },
  };
  const html = renderRow(<BulkEntityRow row={row} set={() => undefined} busy />);
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
});

test("renders revision fields for REVISE_ENTITY operation", () => {
  const row = {
    line: 3,
    op: "REVISE_ENTITY" as const,
    id: "11111111-1111-1111-1111-111111111111",
    expectedVersion: 2,
    draft: { ...emptyDraft(), name: "수정법인", bizKind: "CORPORATION" as const, representatives: ["Lee"] },
  };
  const html = renderRow(
    <BulkEntityRow row={row} set={() => undefined} setRow={() => undefined} />
  );
  expect(html).toContain("법인 수정");
  expect(html).toContain("수정법인");
  expect(html).not.toContain("UUID");
});

test("renders workplace fields for CREATE_WORKPLACE operation", () => {
  const row = {
    line: 4,
    op: "CREATE_WORKPLACE" as const,
    legalEntityId: "22222222-2222-2222-2222-222222222222",
    workplaceName: "부산지사",
    draft: { ...emptyDraft(), name: "부산지사" },
  };
  const html = renderRow(
    <BulkEntityRow row={row} set={() => undefined} setRow={() => undefined} />
  );
  expect(html).toContain("사업장 등록");
  expect(html).toContain("부산지사");
  expect(html).toContain("원천징수·보험");
  expect(html).toMatch(/<fieldset[^>]*disabled=""/);
});


test("correcting an imported workplace name updates both the displayed and submitted name in one edit", () => {
  const row = { line: 2, op: "REVISE_WORKPLACE" as const, id: "workplace", expectedVersion: 2,
    workplaceName: "Before", draft: { ...emptyDraft(), name: "Before" } };
  const setRow = vi.fn();
  renderRow(<BulkEntityRow row={row} set={() => undefined} setRow={setRow} />);
  inputs.get("Before")!.onChange({ target: { value: "After" } });
  expect(setRow).toHaveBeenCalledTimes(1);
  expect(setRow.mock.calls[0]![0]).toMatchObject({ workplaceName: "After", draft: { name: "After" } });
});

test.each([
  ["stale_revision", [], "다른 사람이 먼저 변경"],
  ["legal_entity_not_open", [], "종료된 법인"],
  ["legal_entity_voided", [], "삭제된 법인"],
  ["legal_entity_not_found", [], "이 법인을 찾지 못했습니다"],
  ["workplace_voided", [], "삭제된 사업장"],
  ["workplace_not_found", [], "이 사업장을 찾지 못했습니다"],
  ["validation_failed", [{ field: "registration_id", code: "use_registration_change" }], "등록 변경에서 사업자등록과 일련번호"],
  ["validation_failed", [{ field: "crn", code: "use_identifier_correction" }], "번호는 증빙을 첨부한 번호 정정"],
  ["validation_failed", [{ field: "effective_from", code: "required" }], "변경일: 필수 항목입니다"],
  ["validation_failed", [{ field: "reason_code", code: "required" }], "변경 사유: 필수 항목입니다"],
  ["validation_failed", [{ field: "effective_from", code: "date_invalid" }], "변경일: 날짜가 아닙니다"],
  ["future_refusal", [], "이 값은 받아들여지지 않았습니다"],
] satisfies [string, NonNullable<EntitySetupItem["error"]>["fields"], string][])("bulk revision refusal %s %j uses catalog copy", (code, fields, copy) => {
  const row = { line: 2, op: "REVISE_ENTITY" as const, draft: { ...emptyDraft(), name: "수정법인" } };
  const html = renderRow(<BulkEntityRow row={row} set={() => undefined} error={{ code, fields, message: "raw English server message" }} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain(copy);
  expect(html).not.toContain("raw English server message");
});
