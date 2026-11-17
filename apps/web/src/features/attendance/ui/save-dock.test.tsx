// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Drafts } from "../domain/grid";
import { SaveDock } from "./save-dock";
import { usePreview } from "./use-preview";

vi.mock("./use-preview", async importOriginal => {
  const actual = await importOriginal<typeof import("./use-preview")>();
  return { ...actual, usePreview: vi.fn(actual.usePreview) };
});

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

test("a draft waits for the preview before showing evidence or save controls", () => {
  const html = render({ "person|2026-10-06": { value: "=", base: null } });
  expect(html).toContain("<aside");
  expect(html).toContain(t("attendanceRecords.save.title", { count: 1 }));
  expect(html).toContain(t("attendanceRecords.save.previewing"));
  expect(html).not.toContain(t("attendanceRecords.evidence.label"));
  expect(html).not.toContain(t("attendanceRecords.save.commit", { count: 1 }));
});

test("a resolved preview requires evidence before Save is enabled", () => {
  vi.mocked(usePreview).mockReturnValueOnce({
    data: { cells: [], ok: 1, unchanged: 0, refused: 0, conflicts: 0, closes: { blocking: 0, decision: 0, info: 0 }, opens: { blocking: 0, decision: 0, info: 0 } },
    stale: undefined, error: undefined, pending: false,
  });
  const html = render({ "person|2026-10-06": { value: "=", base: null } });
  expect(html).toContain(t("attendanceRecords.evidence.label"));
  expect(html).toContain(t("attendanceRecords.save.needsEvidence"));
  const save = html.match(/<button[^>]*>.*?<\/button>/g)?.find(button => button.includes(t("attendanceRecords.save.commit", { count: 1 })));
  expect(save).toContain('aria-disabled="true"');
  expect(save).toContain(t("attendanceRecords.save.commit", { count: 1 }));
});
