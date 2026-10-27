// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { TabCount, Tabs } from "./tabs";
import { PageTabs } from "./page-tabs";

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

test("URL views use current links and refuse temporarily unavailable destinations", () => {
  const html = renderToStaticMarkup(<PageTabs label="보기" selected="unavailable" href={id => `?tab=${id}`} onSelect={() => {}}
    items={[{ id: "unavailable", label: "준비 중", disabledReason: "먼저 설정합니다" }, ...items]}>{id => <p>{id}</p>}</PageTabs>);
  expect(html).toContain('<nav');
  expect(html).not.toContain('role="tab');
  expect(html).toContain('href="?tab=first" aria-current="page"');
  expect(html).not.toContain('href="?tab=unavailable"');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("먼저 설정합니다");
  expect(html).toContain(">first</p>");
  expect(html).not.toContain(">unavailable</p>");
});

test("no usable URL views render no content, and empty URL views render nothing", () => {
  const renderLinks = (available: { id: string; label: string; disabledReason: string }[]) => renderToStaticMarkup(
    <PageTabs label="보기" selected="later" href={id => `?tab=${id}`} onSelect={() => {}} items={available}>{id => <p>{id}</p>}</PageTabs>,
  );
  expect(renderLinks([])).toBe("");
  const html = renderLinks([{ id: "later", label: "준비 중", disabledReason: "먼저 설정합니다" }]);
  expect(html).not.toContain("data-page-view");
  expect(html).not.toContain("aria-current");
  expect(html).toContain("먼저 설정합니다");
});
