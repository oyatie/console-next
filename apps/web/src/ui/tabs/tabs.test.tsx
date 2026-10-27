// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { TabCount, Tabs } from "./tabs";

beforeAll(() => loadCatalog("ko"));
const items = [{ id: "first", label: "첫 보기", count: 0 }, { id: "second", label: "다음 보기", count: 2000 }];
const render = (selected: string, available = items) => renderToStaticMarkup(
  <Tabs label="보기" items={available} selected={selected} onSelect={() => {}}>{id => <p>{id}</p>}</Tabs>,
);

test("unknown and removed selections fall back to the first available tab", () => {
  for (const selected of ["unknown", "second"]) {
    const html = render(selected, items.slice(0, 1));
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain(">first</p>");
    expect(html).not.toContain(">second</p>");
  }
});

test("counts distinguish loaded zero from unknown values and use the active locale", () => {
  for (const count of [undefined, "", -1, NaN, Infinity] as const) {
    expect(renderToStaticMarkup(<TabCount>{count}</TabCount>)).not.toMatch(/>[^<]+<\/span>/);
  }
  expect(render("first")).toMatch(/>0<\/span>/);
  expect(render("second")).toContain("2,000");
});

test("an empty available list has no phantom tab or panel", () => {
  expect(render("unknown", [])).toBe("");
});
