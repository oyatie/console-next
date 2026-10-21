// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { emptyDraft } from "../domain/draft";
import { BulkEntityRow } from "./bulk-entity-row";

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
  expect(html).toContain("11111111-1111-1111-1111-111111111111");
  expect(html).toContain("2");
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
  expect(html).toContain("22222222-2222-2222-2222-222222222222");
});
