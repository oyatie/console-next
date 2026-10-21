import { afterEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Minimap } from "./minimap";

afterEach(() => vi.unstubAllGlobals());
const html = (userId?: string) => renderToStaticMarkup(<Minimap userId={userId} size={{ w: 1000, h: 1000 }} rects={[]} view={{ zoom: 1, x: 0, y: 0 }} vp={{ w: 800, h: 600 }} onCentre={() => {}} onFit={() => {}} />);

test("the collapsed overview belongs to the signed-in user, including after a new mount", () => {
  const store = new Map([["console.orgCanvas.minimap.user-a", "collapsed"]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null });
  expect(html("user-a")).toContain('aria-expanded="false"');
  expect(html("user-a")).toContain('data-collapsed="true"');
  expect(html("user-b")).toContain('aria-expanded="true"');
  expect(html()).toContain('aria-expanded="true"');
});

test("blocked or unrecognized browser storage keeps the overview usable and expanded", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  expect(html("user-a")).toContain('aria-expanded="true"');
  vi.stubGlobal("localStorage", { getItem: () => "invalid" });
  expect(html("user-a")).toContain('aria-expanded="true"');
});
