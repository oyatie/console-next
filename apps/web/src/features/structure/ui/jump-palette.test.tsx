// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { PaletteSection } from "../../../ui/command-palette/command-palette";
import { JumpPalette } from "./jump-palette";

const view = vi.hoisted(() => ({ query: "", sections: [] as readonly PaletteSection[], people: [] as { id: string; name: string }[], navigate: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(), useState: () => [view.query, vi.fn()],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => view.navigate }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: view.people } }) }));
vi.mock("./use-structure", () => ({ useStructure: () => ({ s: undefined }) }));
vi.mock("../../../ui/command-palette/command-palette", () => ({
  CommandPalette: ({ sections }: { sections: readonly PaletteSection[] }) => { view.sections = sections; return null; },
}));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.people = []; });

test.each(["x".repeat(16), "x".repeat(200), "  request/with?reserved#characters  ", "😀".repeat(16)])("pasted request key %s opens the existing resolver with the trimmed key", key => {
  view.query = key;
  view.navigate.mockClear();
  renderToStaticMarkup(<JumpPalette onClose={() => {}} />);
  const item = view.sections.flatMap(section => section.items).find(item => item.id === "request");
  expect(item?.label).toBe(t("requestOutcome.find"));
  expect(item?.detail).toBe(key.trim());
  item!.onAction();
  expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/requests/$id", params: { id: key.trim() } });
});

test.each(["", "x".repeat(15), "x".repeat(201), "😀".repeat(15)])("invalid request key %s never offers a resolver action", key => {
  view.query = key;
  renderToStaticMarkup(<JumpPalette onClose={() => {}} />);
  expect(view.sections.flatMap(section => section.items).find(item => item.id === "request")).toBeUndefined();
});

test("a long matching name keeps the person ahead of the optional request lookup", () => {
  view.query = "a long matching name";
  view.people = [{ id: "person-1", name: view.query }];
  renderToStaticMarkup(<JumpPalette onClose={() => {}} />);
  const ids = view.sections.flatMap(section => section.items).map(item => item.id);
  expect(ids).toContain("request");
  expect(ids[0]).toBe("person:person-1");
});
