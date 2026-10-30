// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { ApiError, session } from "@console/api";
import type { Checklist } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import { PhaseLine } from "../ui/page-head/phase-line";
import { PageHead } from "../ui/page-head/page-head";
import { PageHeadingLevel } from "../ui/page/page-scope";
import { checklist } from "../../../../e2e/mock/fixtures";
import { PhaseBand } from "./phase-band";

const state = vi.hoisted(() => ({ error: null as unknown, pending: false, data: undefined as Checklist | undefined,
  phase: "OPERATING" as "SETUP" | "OPERATING" | undefined, accessError: null as unknown, accessPending: false, retry: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.phase ? { phase: state.phase } : undefined,
  isPending: state.accessPending, isError: !!state.accessError, error: state.accessError, refetch: state.retry,
}) }));
vi.mock("../features/onboarding/ui/use-setup", () => ({ useSetupChecklist: () => ({ q: {
  data: state.data, dataUpdatedAt: 0, isPending: state.pending, isError: !!state.error, error: state.error,
  refetch: state.retry,
} }) }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); state.phase = "OPERATING"; state.accessPending = false; state.accessError = null; state.pending = false; state.error = null; state.data = undefined; });
const content = "route content";
const render = () => renderToStaticMarkup(<PhaseBand><PageHead title="Route" /><p>{content}</p></PhaseBand>);

test("a checklist fault keeps the honest phase with its subject and retry, without another alert", () => {
  state.error = new ApiError(503, "service_unavailable", "busy", [], "read-outage", true);
  const html = render();
  expect(html).toContain('data-phase-band="failed"');
  expect(html).toContain('data-phase="operating"');
  expect(html).toContain(t("setup.phase.checklistFailed"));
  expect(html).toContain(t("common.read.failedReason"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("read-outage");
  expect(html.indexOf('data-phase-band')).toBeLessThan(html.indexOf("</header>"));
});

test.each(["SETUP", "OPERATING"] as const)("a skipped or refused checklist leaves the accessible %s phase without an error or next step", phase => {
  state.phase = phase;
  for (const error of [null, new ApiError(403, "forbidden", "refused")]) {
    state.error = error;
    // Cached administrator data must not become an employee's next step after a refusal.
    state.data = error ? { ...checklist, phase: "SETUP", steps: [{ key: "entity", state: "todo" }] as Checklist["steps"] } : undefined;
    const html = render();
    expect(html).toContain(`data-phase="${phase === "SETUP" ? "setup" : "operating"}"`);
    expect(html).not.toContain(t("common.read.failedReason"));
    expect(html).not.toContain(t("common.retry"));
    expect(html).not.toContain(t("setup.step.entity"));
  }
});

test("the accessible phase owns the loading skeleton and a phase fault names its subject with retry", () => {
  state.phase = undefined;
  state.accessPending = true;
  expect(render()).toContain('aria-busy="true"');
  state.accessPending = false;
  state.accessError = new ApiError(503, "service_unavailable", "busy");
  const html = render();
  expect(html).toContain(t("setup.phase.failed"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain('data-phase="operating"');
});

test("the first successful operating receipt is past tense inside the page head", () => {
  state.data = { ...checklist, go_live_at: new Date().toISOString() };
  const html = render();
  expect(t("setup.phase.started.title")).toBe("운영을 시작했습니다");
  expect(t("setup.phase.started.detail")).toBe("설정 단계의 되돌리기는 이제 정정으로 기록합니다.");
  expect(html).toContain(t("setup.phase.started.title"));
  expect(html).not.toContain("→");
  expect(html.indexOf(t("setup.phase.started.title"))).toBeLessThan(html.indexOf("</header>"));
  expect(html).not.toContain('data-placement="page"');
});

test.each([null, "2020-01-01T00:00:00Z"])("operating remains visible without a current receipt: %s", go_live_at => {
  state.data = { ...checklist, go_live_at };
  const html = render();
  expect(html).toContain('data-phase="operating"');
  expect(html).toContain(t("entityRecord.phase.operating"));
});

test("setup names the next unfinished server step", () => {
  state.phase = "SETUP";
  state.data = { ...checklist, phase: "SETUP", go_live_at: null, steps: [
    { key: "entity", state: "done" }, { key: "workplace", state: "todo" },
  ] as Checklist["steps"] };
  const html = render();
  expect(html).toContain('data-phase="setup"');
  expect(html).toContain(t("shell.phase.setup"));
  expect(html).toContain(t("setup.step.workplace"));
  expect(html).not.toContain(t("setup.step.entity"));
});

test.each(["broken JSON", null])("a pending checklist retains the accessible phase even on a cold visit: %s", value => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  vi.stubGlobal("localStorage", { getItem: () => value });
  state.pending = true;
  const html = render();
  expect(html).toContain('data-phase-band="ready"');
  expect(html).toContain('data-phase="operating"');
  expect(html.indexOf('data-phase-band')).toBeLessThan(html.indexOf("</header>"));
  expect(html).toContain("route content");
});

test("blocked storage still renders the phase slot", () => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  state.pending = true;
  expect(render()).toContain('data-phase="operating"');
});

test("embedded page heads do not duplicate the phase", () => {
  state.data = checklist;
  const html = renderToStaticMarkup(<PhaseBand><PageHead title="Route" /><PageHeadingLevel value={2}><PageHead title="Section" /></PageHeadingLevel></PhaseBand>);
  expect(html.match(/data-phase-band=/g)).toHaveLength(1);
});

test("the reserved phase preserves a caller's page-specific phase notes and other metadata", () => {
  state.data = checklist;
  const legacy = "legacy phase detail", code = "record code";
  const html = renderToStaticMarkup(<PhaseBand><PageHead title="Route" meta={<><PhaseLine phase="setup">{legacy}</PhaseLine><span>{code}</span></>} /></PhaseBand>);
  expect(html.match(/data-phase=/g)).toHaveLength(2);
  expect(html).toContain(legacy);
  expect(html).toContain(code);
});
