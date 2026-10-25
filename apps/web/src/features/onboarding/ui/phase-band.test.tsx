import { beforeAll, afterEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { PhaseBand } from "../../../shell/phase-band";

// Model the timestamp captured by the mounted setup shell, before its go-live response arrives.
const times = vi.hoisted(() => ({ mounted: Date.parse("2026-10-09T00:00:00Z"), updatedAfter: 2000 }));
vi.mock("./use-setup", () => ({ useSetupChecklist: () => ({ phaseQ: {
  data: { phase: "OPERATING", go_live_at: "2026-10-09T00:00:01Z" },
  dataUpdatedAt: times.mounted + times.updatedAfter, isPending: false,
} }) }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => initial === Date.now ? [times.mounted, () => undefined] : react.useState(initial) };
});
beforeAll(() => loadCatalog("ko"));
afterEach(() => { times.updatedAfter = 2000; vi.useRealTimers(); });

test("an already mounted setup shell shows the reminder when a later go-live response arrives", () => {
  vi.useFakeTimers();
  vi.setSystemTime(times.mounted + 2000);
  const content = "route content";
  const html = renderToStaticMarkup(<PhaseBand><span>{content}</span></PhaseBand>);
  expect(html).toContain("운영 시작 · 되돌리기 → 정정");
  expect(html).toContain("route content");
});

test("the operating reminder stays present when the server clock is ahead of the client", () => {
  times.updatedAfter = 500; // the response says OPERATING; its server timestamp is 500 ms ahead
  vi.useFakeTimers();
  vi.setSystemTime(times.mounted + 500);
  const content = "route content";
  const html = renderToStaticMarkup(<PhaseBand><span>{content}</span></PhaseBand>);
  expect(html).toContain("운영 시작 · 되돌리기 → 정정");
  expect(html).toContain(content);
});
