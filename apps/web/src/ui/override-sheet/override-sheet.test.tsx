// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import { OverrideSheet } from "./override-sheet";

vi.mock("../dialog", () => ({ Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
beforeAll(() => loadCatalog("ko"));

test("pending confirmation stays disabled with its own accessible busy state", () => {
  const html = renderToStaticMarkup(<OverrideSheet open title="Synthetic exception" rule={{ title: "Synthetic rule", detail: "" }} risk="low" route={{ kind: "record" }} reason={null} reasonComplete pending commitLabel="Synthetic commit" onCommit={() => {}} onClose={() => {}} />);
  expect(html).toMatch(/<button[^>]*aria-busy="true"/);
  expect(html.match(/disabled=""/g)).toHaveLength(2);
});

test.each([
  [403, "forbidden", true],
  [403, "step_up_failed", false],
  [401, "step_up_failed", false],
  [409, "lifecycle.refuse.stale_version", false],
] as const)("%i %s locks only an authorization refusal", (status, code, locked) => {
  const html = renderToStaticMarkup(<OverrideSheet open title="Synthetic exception" rule={{ title: "Synthetic rule", detail: "" }} risk="low" route={{ kind: "record" }} reason={null} reasonComplete error={{ status, code }} commitLabel="Synthetic commit" onCommit={() => {}} onClose={() => {}} />);
  expect(html.match(/disabled=""/g) ?? []).toHaveLength(locked ? 1 : 0);
});

test.each(["step-up", "sole-holder"] as const)("%s binding keeps an unknown action readable", (kind) => {
  const html = renderToStaticMarkup(<OverrideSheet open title="Synthetic exception" rule={{ title: "Synthetic rule", detail: "" }} risk="low" route={{ kind, notified: 0, binding: { action: "FUTURE_ACTION", hash: "abc" } }} reason={null} reasonComplete commitLabel="Synthetic commit" onCommit={() => {}} onClose={() => {}} />);
  expect(html).toContain("확인되지 않은 항목");
  expect(html).toContain('<span class="chip chip--neutral">FUTURE_ACTION</span>');
  expect(html.split("FUTURE_ACTION")).toHaveLength(2);
});
