// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ApiError, session } from "@console/api";
import type { Checklist } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { PhaseBand } from "./phase-band";

const state = vi.hoisted(() => ({ error: null as unknown, pending: false, data: undefined as Checklist | undefined }));
const routeContent = "route";
vi.mock("../features/onboarding/ui/use-setup", () => ({ useSetupChecklist: (placeholderData?: Checklist) => {
  const q = { data: state.data ?? placeholderData, dataUpdatedAt: 0, isPending: state.pending && !placeholderData, isError: !!state.error, error: state.error };
  return { q, phaseQ: q };
} }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); state.pending = false; state.error = null; state.data = undefined; });

test("a failed shell checklist adds no failure card beside its route", () => {
  state.error = new ApiError(503, "service_unavailable", "busy", [], "read-outage", true);
  const html = renderToStaticMarkup(<PhaseBand><p>{t("home.title")}</p></PhaseBand>);
  expect(html).toBe(`<p>${t("home.title")}</p>`);
});

test("the first successful operating receipt is past tense and precedes the page", () => {
  state.data = { phase: "OPERATING", go_live_at: new Date().toISOString() } as Checklist;
  const html = renderToStaticMarkup(<PhaseBand><p>{routeContent}</p></PhaseBand>);
  expect(t("setup.phase.started.title")).toBe("운영을 시작했습니다");
  expect(t("setup.phase.started.detail")).toBe("설정 단계의 되돌리기는 이제 정정으로 기록합니다.");
  expect(html).not.toContain("→");
  expect(html.indexOf(t("setup.phase.started.title"))).toBeLessThan(html.indexOf("<p>route</p>"));
  expect(html).not.toContain("sticky");
});

test.each([
  { phase: "SETUP", go_live_at: null, title: "setup.phase.setup.title" as const },
  { phase: "OPERATING", go_live_at: new Date().toISOString(), title: "setup.phase.started.title" as const },
  { phase: "OPERATING", go_live_at: null, title: null },
])("the viewer's last $phase answer seeds the first paint, including no band", ({ phase, go_live_at, title }) => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  const getItem = vi.fn(() => JSON.stringify({ phase, go_live_at }));
  vi.stubGlobal("localStorage", { getItem });
  state.pending = true;
  const html = renderToStaticMarkup(<PhaseBand><p>{routeContent}</p></PhaseBand>);
  expect(getItem).toHaveBeenCalledWith('console.phase.["tenant","viewer"]');
  if (title) {
    expect(html).toContain(t(title));
    expect(html.indexOf(t(title))).toBeLessThan(html.indexOf("<p>route</p>"));
  }
  else expect(html).toBe("<p>route</p>");
});

test.each(["broken JSON", '{"phase":"invented"}', '{"phase":"OPERATING","go_live_at":"bad date"}'])("invalid storage leaves no pushing phase slot: %s", value => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  vi.stubGlobal("localStorage", { getItem: () => value });
  state.pending = true;
  expect(renderToStaticMarkup(<PhaseBand><p>{routeContent}</p></PhaseBand>)).toBe("<p>route</p>");
});

test("blocked storage does not prevent the route from mounting", () => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  state.pending = true;
  expect(renderToStaticMarkup(<PhaseBand><p>{routeContent}</p></PhaseBand>)).toBe("<p>route</p>");
});

test("a refused shell read keeps its existing presentation", () => {
  state.error = new ApiError(403, "forbidden", "refused");
  expect(renderToStaticMarkup(<PhaseBand><p>{t("home.title")}</p></PhaseBand>)).toBe(`<p>${t("home.title")}</p>`);
});

test("a failed checklist keeps the remembered receipt without another alert or reference", () => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ phase: "OPERATING", go_live_at: new Date().toISOString() }) });
  state.error = new ApiError(503, "service_unavailable", "busy", [], "read-outage");
  const html = renderToStaticMarkup(<PhaseBand><p>{routeContent}</p></PhaseBand>);
  expect(html).toContain(t("setup.phase.started.title"));
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("read-outage");
});

test("a held phase read keeps the route without guessing an above-route banner height", () => {
  const content = "route loading";
  state.pending = true;
  state.error = null;
  try {
    const html = renderToStaticMarkup(<PhaseBand><div role="status">{content}</div></PhaseBand>);
    expect(html).toContain("route loading");
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).not.toContain('data-placement="page"');
  } finally { state.pending = false; }
});
