// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup as html } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { ItemList } from "./item-list";

beforeAll(() => loadCatalog("ko"));

test("ItemList renders items, marks and end text", () => {
  const markX = "[x]";
  const out = html(
    <ItemList
      items={[
        { key: "1", mark: <span>{markX}</span>, text: "Item 1", end: "Active", tone: "ok" },
        { key: "2", text: "Item 2", end: "Pending", tone: "warn", onSelect: () => undefined },
      ]}
      label="Tasks"
    />
  );
  expect(out).toContain("Item 1");
  expect(out).toContain("Active");
  expect(out).toContain('data-tone="ok"');
  expect(out).toContain("<button");
  expect(out).toContain('type="button"');
});

test("ItemList renders loading state with skeleton and aria-busy", () => {
  const out = html(<ItemList items={[]} loading />);
  expect(out).toContain('aria-busy="true"');
  expect(out).toContain('role="status"');
});

test("ItemList renders empty state keeps its labelled container without domain prose", () => {
  const out = html(<ItemList items={[]} />);
  expect(out).not.toContain("조직도");
  expect(out).toContain("<ul");
});

test("ItemList renders error state with role alert and data-state error", () => {
  const out = html(<ItemList items={[]} error="Failed to load items" />);
  expect(out).toContain('role="alert"');
  expect(out).toContain('data-state="error"');
  expect(out).toContain("Failed to load items");
});
