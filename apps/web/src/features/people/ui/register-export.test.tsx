// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { RegisterExport } from "./register-export";

vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: { items: [{ id: "e-1", name: "Test Person", job: "Lead", hire_date: "2020-01-02", exit_date: "2026-10-31" }] } }),
}));
vi.mock("./use-register-sites", () => ({
  useSites: () => [{ id: "entity", name: "Test Co", sites: [{ id: "site", entity: "Test Co", name: "Plant", workers: 1, exited: 1 }] }],
  usePreviewFacts: () => () => ({ sex: "—", birth: "—", address: "—", history: "—" }),
}));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ isError: false, error: null, mutate: () => undefined }) }));
vi.mock("../../../lib/pure/today", () => ({ todayKst: () => "2026-10-23" }));

beforeAll(() => loadCatalog("ko"));

test("the register paper keeps the locale date form whatever day style the screen draws", () => {
  const screenStyle = i18n.dateStyle;
  i18n.dateStyle = () => "iso";
  try {
    const html = renderToStaticMarkup(<RegisterExport onClose={() => undefined} />);
    // The as-of choice beside the paper is a screen control and follows the screen style.
    expect(html).toContain(t("empDoc.reg.asOf.today", { date: "2026-10-23" }));
    const paper = html.match(/<article[^>]*data-paper[^]*?<\/article>/)?.[0] ?? "";
    expect(paper).toContain(t("empDoc.reg.paperAsOf", { date: "2026. 10. 23." }));
    expect(paper).toContain("<td>2020. 01. 02.</td>");
    expect(paper).toContain("<td>2026. 10. 31.</td>");
    expect(paper).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  } finally {
    i18n.dateStyle = screenStyle;
  }
});
