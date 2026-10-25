// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { OrgStructureNode } from "@console/api/pending";
import type { Button } from "../../../ui/button/button";
import type { Sheet } from "../../../ui/sheet/sheet";
import { buildStructure, type ChartNode } from "../domain/model";
import { ExportDialog } from "./export-dialog";
import { RegistryExportContext } from "./export-scope";

const view = vi.hoisted(() => ({ buttons: [] as Parameters<typeof Button>[0][], saveFile: vi.fn((_blob: Blob, _name: string) => undefined) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({}) }) }));
vi.mock("../../../lib/download", () => ({ saveFile: view.saveFile }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: (p: Parameters<typeof Sheet>[0]) => <>{p.title}{p.children}{p.actions}</> }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (p: Parameters<typeof Button>[0]) => { view.buttons.push(p); return <actual.Button {...p} />; } };
});

const node = (kind: OrgStructureNode["kind"], id: string, name: string, children: OrgStructureNode[] = []): OrgStructureNode =>
  ({ kind, id, name, headcount: 2, direct_headcount: 0, dispatched_headcount: 0, chips: [], children });
const s = buildStructure({ tenant_name: "테넌트", phase: "SETUP", unplaced: [], as_of: "2026-10-06", known_at: "2026-10-06T00:00:00Z", entities: [
  node("LEGAL_ENTITY", "entity", "법인", [node("WORKPLACE", "site", "사업장", [node("DEPARTMENT", "visible", "보이는부서"), node("DEPARTMENT", "hidden", "숨긴부서")])]),
] });
const visible = [s.byId.get("visible")!];
const render = (rows: readonly ChartNode[] | null) => renderToStaticMarkup(<RegistryExportContext.Provider value={rows}><ExportDialog s={s} onClose={() => {}} /></RegistryExportContext.Provider>);
const label = (button: Parameters<typeof Button>[0]) => renderToStaticMarkup(<>{button.children}</>);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.buttons = []; view.saveFile.mockClear(); });

test("list scope previews exactly the visible rows with one CSV command", () => {
  const html = render(visible);
  expect(html).toContain(t("structureChart.export.visible", { count: 1 }));
  expect(html).toContain("보이는부서");
  expect(html).not.toContain("숨긴부서");
  expect(html.match(/<th[ >]/g)).toHaveLength(9);
  expect(html).toContain(t("asof.label"));
  expect(html).toContain(t("asof.knownAt"));
  expect(html).not.toContain(`>${t("structure.export.depth")}<span`);
  expect(html).not.toContain(t("structure.export.format"));
  expect(html).not.toContain(t("structureChart.export.pages"));
  expect(html).not.toContain("<img");
  expect(view.buttons.filter((button) => label(button).includes(t("structureChart.list.download")))).toHaveLength(1);
});

test("the CSV command saves only the exact previewed rows", async () => {
  render(visible);
  const commit = view.buttons.find((button) => button.variant === "primary")!;
  expect(label(commit)).toContain(t("structureChart.list.download"));
  commit.onClick?.({} as MouseEvent<HTMLButtonElement>);
  expect(view.saveFile).toHaveBeenCalledOnce();
  const [blob, filename] = view.saveFile.mock.calls[0]!;
  const csv = await blob.text();
  expect(filename).toBe(t("structureChart.sheet.file", { date: s.asOf }));
  expect(csv).toContain("보이는부서");
  expect(csv).not.toContain("숨긴부서");
  expect(csv).toContain(s.asOf);
  expect(csv).toContain(s.knownAt);
  expect(csv.split("\r\n")).toHaveLength(3);
});

test("chart scope keeps its format, depth, paper preview and print command", () => {
  const html = render(null);
  expect(html).not.toContain(t("structureChart.export.visible", { count: 0 }));
  expect(html).toContain(t("structure.export.depth"));
  expect(html).toContain(t("structure.export.format"));
  expect(html).toContain(t("structure.export.size"));
  expect(html).toContain("<img");
  expect(label(view.buttons.find((button) => button.variant === "primary")!)).toContain(t("structure.export.print"));
});
