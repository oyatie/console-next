// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { structure } from "../../../../../../e2e/mock/fixtures";
import { buildStructure } from "../domain/model";
import type { Commands } from "./use-structure-commands";
import { ChartView } from "./chart-view";
import { NameBox } from "./name-box";

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useNavigate: () => vi.fn(), useSearch: () => ({}) }),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
}));

beforeAll(() => loadCatalog("ko"));

const commands = (): Commands => ({
  readOnly: false,
  apply: vi.fn(),
  propose: vi.fn(),
  order: vi.fn(),
  pending: false,
  error: null,
  failed: undefined,
  reset: vi.fn(),
  last: null,
  undo: vi.fn(),
  undoing: false,
  dismiss: vi.fn(),
});

test.each([
  [false, true],
  [true, false],
])("ChartView omits node tools when covered=%s", (covered, hasTools) => {
  const s = buildStructure(structure(2));
  const site = [...s.byId.values()].find((n) => n.kind === "site")!;
  const html = renderToStaticMarkup(
    <ChartView
      s={s}
      cmd={commands()}
      covered={covered}
      onFocus={vi.fn()}
      sel={new Set([site.id])}
      onSelect={vi.fn()}
    />,
  );
  const label = `aria-label="${t("structure.tools.label", { name: site.name })}"`;
  expect(html.includes(label)).toBe(hasTools);
  expect(html.includes("data-tools")).toBe(hasTools);
});

test("NameBox renders a static 적용일 · 오늘 chip in setup and a picker chip clamping past asOf after go-live", () => {
  const s = buildStructure(structure(2));
  const site = [...s.byId.values()].find((n) => n.kind === "site")!;
  const box = { node: site, lod: "m" as const, x: 0, y: 0, w: 280, h: 132 };
  const chipLabel = `aria-label="${t("orgUnit.gov.date")} · ${t("asof.today")}"`;
  const setupHtml = renderToStaticMarkup(
    <NameBox box={box} parent={site} setup={true} pending={false} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  expect(setupHtml).toContain(`${t("orgUnit.gov.date")} · ${t("asof.today")}`);
  expect(setupHtml).not.toContain(chipLabel);
  const opHtml = renderToStaticMarkup(
    <NameBox box={box} parent={site} setup={false} asOf="2020-01-01" pending={false} onSubmit={vi.fn()} onCancel={vi.fn()} />,
  );
  expect(opHtml).toContain(chipLabel);
});
