// SPDX-License-Identifier: LicenseRef-Proprietary
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { bulkBlock, type Row } from "../domain/bulk";
import type { Button } from "../../../ui/button/button";
import type { Sheet } from "../../../ui/sheet/sheet";
import { BulkSheet } from "./bulk-sheet";

const view = vi.hoisted(() => ({
  cursor: 0, draft: {}, ready: true, rows: [] as Row[],
  buttons: [] as Parameters<typeof Button>[0][], send: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => view.cursor++ === 1 ? [view.draft, vi.fn()] : actual.useState(initial) };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [], entities: [] }, isSuccess: true }) }));
vi.mock("./use-bulk-rows", () => ({ useBulkRows: () => ({ rows: view.rows, lines: [], ready: view.ready, progress: { done: 0, total: 1 } }) }));
vi.mock("../../../lib/reason-codes", () => ({ reasonCodesQuery: vi.fn(), useReasonCodesReady: () => true }));
vi.mock("./use-bulk-command", () => ({ useBulkCommand: () => ({ recorded: [], recordedIds: new Set(), refused: new Map(), stale: new Set(), send: view.send }) }));
// React Aria portals are covered by E2E; keep this unit proof on the composer's actual footer.
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: (p: Parameters<typeof Sheet>[0]) => <>{p.consequence}{p.actions}</> }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (p: Parameters<typeof Button>[0]) => { view.buttons.push(p); return <actual.Button {...p} />; } };
});
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  view.cursor = 0; view.ready = true; view.rows = []; view.buttons = []; view.send.mockClear();
  view.draft = { text: "", kind: "TRANSFER", unitId: "unit", position: "", date: "2099-12-31", code: "OTHER", comment: "Assignment" };
});
const input = () => ({ missingCount: 0, errorLines: 0, count: 1, checking: false, failed: false, progress: { done: 1, total: 1 } });
test.each([
  [{ missingCount: 1 }, { id: "bulk.missing", params: { count: 1 } }],
  [{ count: 0, errorLines: 2 }, { id: "bulk.errorsLeft", params: { count: 2 } }],
  [{ checking: true }, { id: "bulk.paste.checking", params: { done: 1, total: 1 } }],
  [{ failed: true, checking: true }, { id: "bulk.paste.failed" }],
  [{ count: 0 }, { id: "bulk.noTargets" }],
] as const)("bulk appointment refusal %j is exact", (change, expected) => {
  expect(bulkBlock({ ...input(), ...change })).toEqual(expected);
});
test.each([
  ["targets", {}, true],
  ["kind", { kind: null }, false],
  ["unit", { unitId: "" }, false],
  ["position", { kind: "PROMOTE", position: "" }, false],
  ["date", { date: "" }, false],
  ["code", { code: null }, false],
  ["comment", { comment: " \u3000" }, false],
] as const)("one missing %s is one visible field, never an invented target", (_field, change, paste) => {
  view.draft = { ...view.draft, ...change };
  const source = paste ? { paste: "" } : { picked: new Map<string, string>() };
  const html = renderToStaticMarkup(<BulkSheet source={source} onClose={vi.fn()} onDone={vi.fn()} />);
  expect(html).toContain(t("bulk.missing", { count: 1 }));
});
test("complete appointments need no block", () => expect(bulkBlock(input())).toBeNull());
test("an empty roster has no invisible paste field, and its primary names the missing targets once", () => {
  const html = renderToStaticMarkup(<BulkSheet source={{ picked: new Map() }} onClose={vi.fn()} onDone={vi.fn()} />);
  const button = html.match(/<button[^>]*class="[^"]*btn--primary[^>]*>/)![0];
  expect(button).toContain('aria-disabled="true"');
  expect(button).toContain('type="button"');
  expect(button).not.toMatch(/\sdisabled=/);
  const id = button.match(/aria-describedby="([^"]+)"/)![1];
  expect(html).toContain(`id="${id}">${t("bulk.noTargets")}<`);
  expect(html.split(t("bulk.noTargets"))).toHaveLength(2);
});
test("unmatched rows get the line error rather than an invented missing item", () => {
  view.rows = [{ key: "1", merged: [], target: "", problem: "notFound" }];
  const html = renderToStaticMarkup(<BulkSheet source={{ picked: new Map([["gone", "Gone"]]) }} onClose={vi.fn()} onDone={vi.fn()} />);
  expect(html).toContain(t("bulk.errorsLeft", { count: 1 }));
  expect(html).not.toContain(t("bulk.missing", { count: 1 }));
});
test("checking rows blocks the primary until they resolve, then permits submission", () => {
  view.ready = false;
  const props = { source: { picked: new Map([["one", "One"]]) }, onClose: vi.fn(), onDone: vi.fn() };
  const html = renderToStaticMarkup(<BulkSheet {...props} />);
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain(t("bulk.paste.checking", { done: 0, total: 1 }));
  view.cursor = 0; view.ready = true; view.rows = [{ key: "one", merged: [], target: "", unitId: "unit", employee: { id: "one", name: "One", status: "ACTIVE" } as Row["employee"] }];
  expect(renderToStaticMarkup(<BulkSheet {...props} />)).not.toContain('aria-disabled="true"');
  view.buttons.findLast((p) => p.variant === "primary")!.onClick!({} as MouseEvent<HTMLButtonElement>);
  expect(view.send).toHaveBeenCalledExactlyOnceWith([{ event_type: "TRANSFER", employee_ids: ["one"], to_org_unit_id: "unit", effective_date: "2099-12-31", reason_code: "OTHER", comment: "Assignment" }]);
});
test("a header-only paste names the absence of people without inventing an empty field", () => {
  view.draft = { ...view.draft, text: "사번\t새 조직\t이름" };
  view.ready = false;
  const html = renderToStaticMarkup(<BulkSheet source={{ paste: "" }} onClose={vi.fn()} onDone={vi.fn()} />);
  expect(html).toContain(t("bulk.noTargets"));
  expect(html).not.toContain(t("bulk.missing", { count: 1 }));
  expect(html).not.toContain(t("bulk.paste.checking", { done: 0, total: 1 }));
});
