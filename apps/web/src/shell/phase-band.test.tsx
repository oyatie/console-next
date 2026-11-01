// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ApiError, session } from "@console/api";
import type { Checklist } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { PageHead } from "../ui/page-head/page-head";
import { PageHeadingLevel } from "../ui/page/page-scope";
import { checklist } from "../../../../e2e/mock/fixtures";
import { PhaseBand } from "./phase-band";
import { queryPath } from "../lib/query";

const state = vi.hoisted(() => ({ data: undefined as Checklist | undefined, phase: "OPERATING" as string | undefined,
  error: null as unknown, days: 2 as unknown }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (q: Parameters<typeof queryPath>[0]) => ({
  data: queryPath(q) === "/api/v1/settings" ? { items: [{ key: "onboarding.receipt_days", value: state.days }] }
    : state.phase ? { phase: state.phase } : undefined,
}) }));
vi.mock("../features/onboarding/ui/use-setup", () => ({ useSetupChecklist: () => {
  const q = { data: state.data, dataUpdatedAt: 0, isError: !!state.error, error: state.error };
  return { q, phaseQ: q };
} }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); state.phase = "OPERATING"; state.data = undefined; state.error = null; state.days = 2; });
const tabs = "Tabs", content = "route content";
const render = () => renderToStaticMarkup(<PhaseBand><PageHead title="Route" tabs={<nav>{tabs}</nav>} /><p>{content}</p></PhaseBand>);

test("a cold checklist outage adds no phase or alert card", () => {
  state.error = new ApiError(503, "service_unavailable", "busy");
  const html = render();
  expect(html).not.toContain("data-phase-band");
  expect(html).not.toContain('role="alert"');
  expect(html).toContain("route content");
});

test.each([null, "2020-01-01T00:00:00Z"])("operating without a current receipt renders nothing: %s", go_live_at => {
  state.data = { ...checklist, go_live_at };
  expect(render()).not.toContain("data-phase-band");
});

test.each([undefined, 0, -1, "2", NaN, Infinity])("invalid or disabled duration %s never invents a receipt window", days => {
  state.days = days;
  state.data = { ...checklist, go_live_at: new Date().toISOString() };
  expect(render()).not.toContain("data-phase-band");
});

test("the receipt is past tense, readable text, directly under the heading and before tabs", () => {
  state.data = { ...checklist, go_live_at: new Date().toISOString() };
  const html = render();
  expect(html).toContain(t("setup.receipt.started.title"));
  expect(html).toContain(`>${t("setup.receipt.started.detail")}<`);
  expect(html).not.toContain("→");
  expect(html).not.toContain('data-phase="operating"');
  expect(html.indexOf("</h1>")).toBeLessThan(html.indexOf("data-phase-band"));
  expect(html.indexOf("data-phase-band")).toBeLessThan(html.indexOf("<nav>"));
});

test("the configured window expires, rather than the previous fixed seven days", () => {
  state.data = { ...checklist, go_live_at: new Date(Date.now() - 3 * 86400000).toISOString() };
  expect(render()).not.toContain("data-phase-band");
  state.days = 4;
  expect(render()).toContain("data-phase-band");
});

test("setup names the next unfinished server step, without cached steps after a refusal", () => {
  state.phase = "SETUP";
  state.data = { ...checklist, phase: "SETUP", go_live_at: null, steps: [
    { key: "entity", state: "done" }, { key: "workplace", state: "todo" },
  ] as Checklist["steps"] };
  expect(render()).toContain(t("setup.step.workplace"));
  expect(render()).not.toContain(t("setup.step.entity"));
  state.error = new ApiError(403, "forbidden", "refused");
  expect(render()).not.toContain(t("setup.step.workplace"));
});

test("refetch failure retains a previously answered receipt without another alert", () => {
  state.data = { ...checklist, go_live_at: new Date().toISOString() };
  state.error = new ApiError(503, "service_unavailable", "busy");
  expect(render()).toContain(t("setup.receipt.started.title"));
  expect(render()).not.toContain('role="alert"');
});

test("dismissal is principal-specific and optional storage cannot break rendering", () => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  state.data = { ...checklist, go_live_at: new Date().toISOString() };
  vi.stubGlobal("localStorage", { getItem: () => `OPERATING:${state.data!.go_live_at}` });
  expect(render()).not.toContain("data-phase-band");
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  expect(render()).toContain(t("setup.receipt.started.title"));
});

test("embedded page heads do not duplicate the receipt", () => {
  state.data = { ...checklist, go_live_at: new Date().toISOString() };
  const html = renderToStaticMarkup(<PhaseBand><PageHead title="Route" /><PageHeadingLevel value={2}><PageHead title="Section" /></PageHeadingLevel></PhaseBand>);
  expect(html.match(/data-phase-band=/g)).toHaveLength(1);
});
