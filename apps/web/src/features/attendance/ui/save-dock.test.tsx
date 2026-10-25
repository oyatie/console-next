// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Drafts } from "../domain/grid";
import { SaveDock } from "./save-dock";

beforeAll(() => loadCatalog("ko"));

function render(drafts: Drafts) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}><SaveDock kindOf={() => "WORK"} drafts={drafts} rows={[{ employee_id: "person", name: "Person" }]} month="2026-10" onClose={() => {}} onSaved={() => {}} onFocusCell={() => {}} /></QueryClientProvider>,
  );
  client.clear();
  return html;
}

test("the save dock is absent without drafts even when called directly", () => {
  expect(render({})).toBe("");
});

test("a draft opens the save form and keeps the evidence requirement", () => {
  const html = render({ "person|2026-10-06": { value: "=", base: null } });
  expect(html).toContain("<aside");
  expect(html).toContain(t("attendanceRecords.save.title", { count: 1 }));
  expect(html).toContain(t("attendanceRecords.evidence.label"));
  expect(html).toContain(t("attendanceRecords.save.needsEvidence"));
});
