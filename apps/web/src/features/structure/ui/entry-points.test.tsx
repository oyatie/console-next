// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { FirstRun } from "./first-run";
import { RootActions } from "./root-actions";
import { SetupPanel } from "./setup-panel";
import { buildStructure } from "../domain/model";
import { OutlineView } from "./outline-view";
import type { Commands } from "./use-structure-commands";
import type { Structure } from "../domain/model";
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }), Link: ({ children, to, hash, className }: { children: import("react").ReactNode; to: string; hash?: string; className?: string }) => <span data-href={`${to}${hash ? `#${hash}` : ""}`} className={className}>{children}</span> }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { steps: [] } }) }));
beforeAll(() => loadCatalog("ko"));
test("first run has one primary action and points to the single header import menu", () => {
  const html = renderToStaticMarkup(<FirstRun />);
  expect(html.match(/btn--primary/g)).toHaveLength(1);
  expect(html).toContain('data-href="/org#structure-import"');
  expect(html).not.toMatch(/href="\/(org\/(import|paste)|people\/import)"/);
});
test("canvas and setup refer to the same header menu", () => {
  const root = renderToStaticMarkup(<RootActions box={{ x: 0, y: 0, w: 500, h: 100 } as never} setup zoom={1} visible={{ x: 0, y: 0, w: 500, h: 500 }} />);
  const setup = renderToStaticMarkup(<SetupPanel s={{ root: { headcount: 0 }, counts: { entities: 1, sites: 1, depts: 0 } } as Structure} fixLink={() => null} />);
  for (const html of [root, setup]) {
    expect(html).toContain('data-href="/org#structure-import"');
    expect(html).not.toMatch(/href="\/(org\/(import|paste)|people\/import)"/);
  }
});

vi.mock("./chart-view", () => ({ ChartView: () => null }));
vi.mock("./outline-rows", () => ({ OutlineRows: () => null }));
test("outline importing also points to the header instead of a second paste dialog", () => {
  const s = buildStructure({ tenant_name: "T", phase: "SETUP", entities: [], unplaced: [] });
  const html = renderToStaticMarkup(<OutlineView s={s} cmd={{} as Commands} sel={new Set()} onSelect={() => undefined} />);
  expect(html).toContain('data-href="/org#structure-import"');
  expect(html).not.toContain("목록 붙여넣기");
});

test("outline labels its single headcount as including descendants", async () => {
  const { OutlineRows } = await vi.importActual<typeof import("./outline-rows")>("./outline-rows");
  const s = buildStructure({ tenant_name: "T", phase: "SETUP", entities: [], unplaced: [] });
  const unit = { ...s.root, id: "unit", kind: "dept" as const, name: "품질팀", headcount: 3, children: [], depth: 1 };
  s.root.children = [unit];
  s.byId.set(unit.id, unit);
  s.readOnly = true;
  const html = renderToStaticMarkup(<OutlineRows s={s} cmd={{} as Commands} cursor={unit.id} setCursor={() => undefined} closed={new Set()} setClosed={() => undefined} edit={null} setEdit={() => undefined} sel={new Set()} onSelect={() => undefined} />);
  expect(html).toContain("하위 포함");
  expect(html).toContain("3명");
  expect(html).not.toContain("직속 / 전체");
});
