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

const state = vi.hoisted(() => ({ error: null as unknown, pending: false, data: undefined as Checklist | undefined }));
vi.mock("../features/onboarding/ui/use-setup", () => ({ useSetupChecklist: () => ({ phaseQ: {
  data: state.data, dataUpdatedAt: 0, isPending: state.pending, isError: !!state.error, error: state.error,
} }) }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); state.pending = false; state.error = null; state.data = undefined; });
const content = "route content";
const render = () => renderToStaticMarkup(<PhaseBand><PageHead title="Route" /><p>{content}</p></PhaseBand>);

test.each([503, 403])("a failed checklist keeps the head slot with quiet shared copy, without another alert: %s", status => {
  state.error = new ApiError(status, status === 403 ? "forbidden" : "service_unavailable", "busy", [], "read-outage", true);
  const html = render();
  expect(html).toContain('data-phase-band="failed"');
  expect(html).toContain(t("common.read.failedReason"));
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("read-outage");
  expect(html.indexOf('data-phase-band')).toBeLessThan(html.indexOf("</header>"));
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
  state.data = { ...checklist, phase: "SETUP", go_live_at: null, steps: [
    { key: "entity", state: "done" }, { key: "workplace", state: "todo" },
  ] as Checklist["steps"] };
  const html = render();
  expect(html).toContain('data-phase="setup"');
  expect(html).toContain(t("shell.phase.setup"));
  expect(html).toContain(t("setup.step.workplace"));
  expect(html).not.toContain(t("setup.step.entity"));
});

test.each(["broken JSON", null])("pending reads reserve a skeleton even on a cold visit: %s", value => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  vi.stubGlobal("localStorage", { getItem: () => value });
  state.pending = true;
  const html = render();
  expect(html).toContain('data-phase-band="loading"');
  expect(html).toContain('aria-busy="true"');
  expect(html.indexOf('data-phase-band')).toBeLessThan(html.indexOf("</header>"));
  expect(html).toContain("route content");
});

test("blocked storage still renders the phase slot", () => {
  vi.spyOn(session, "principal", "get").mockReturnValue('["tenant","viewer"]');
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  state.pending = true;
  expect(render()).toContain('data-phase-band="loading"');
});

test("embedded page heads do not duplicate the phase", () => {
  state.data = checklist;
  const html = renderToStaticMarkup(<PhaseBand><PageHead title="Route" /><PageHeadingLevel value={2}><PageHead title="Section" /></PageHeadingLevel></PhaseBand>);
  expect(html.match(/data-phase-band=/g)).toHaveLength(1);
});

test("the reserved phase replaces a caller's phase metadata without hiding other metadata", () => {
  state.data = checklist;
  const legacy = "legacy phase detail", code = "record code";
  const html = renderToStaticMarkup(<PhaseBand><PageHead title="Route" meta={<><PhaseLine phase="setup">{legacy}</PhaseLine><span>{code}</span></>} /></PhaseBand>);
  expect(html.match(/data-phase=/g)).toHaveLength(1);
  expect(html).not.toContain(legacy);
  expect(html).toContain(code);
});
