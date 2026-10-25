// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync } from "node:fs";
import type { MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { bulkBlock, type Missing } from "../domain/grants";
import type { Button } from "../../../ui/button/button";
import type { BulkDraft } from "./bulk-form";
import { BulkPage } from "./bulk-page";

const view = vi.hoisted(() => ({
  cursor: 0, picked: 0, tried: false, draft: null as BulkDraft | null,
  buttons: [] as Parameters<typeof Button>[0][], mutate: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const i = view.cursor++;
    if (i === 0) return [{ kind: "ids", ids: new Set(view.picked ? ["person"] : []) }, vi.fn()];
    if (i === 4) return [view.draft, vi.fn()];
    if (i === 5) return [view.tried, (v: boolean) => { view.tried = v; }];
    return actual.useState(initial);
  } };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { entities: [], items: [] }, isSuccess: true }) }));
vi.mock("./use-access-context", () => ({ useAccessContext: () => ({
  cat: { data: {} }, accounts: [], accountsQ: { data: { items: [] }, isPending: false, error: null }, roles: [], setup: true, q: { data: true, isPending: false, error: null },
}) }));
vi.mock("./access-head", () => ({ AccessHead: () => null }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ mutate: view.mutate }) }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (p: Parameters<typeof Button>[0]) => { view.buttons.push(p); return <actual.Button {...p} />; } };
});
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  view.picked = 1; view.tried = false; view.mutate.mockClear();
  view.draft = { line: { key: "one", role_id: "role", scope: { kind: "TENANT", include_descendants: true }, end: "2099-12-31" }, when: "SETUP", reason: { code: "OTHER", memo: "Assignment" } };
});
const render = () => { view.cursor = 0; view.buttons = []; return renderToStaticMarkup(<BulkPage />); };
const input = () => ({ picked: 1, gaps: [] as Missing[], setup: true, when: "SETUP", reason: { code: "OTHER", memo: "Assignment" } });

test.each([
  [{ picked: 0 }, "access.bulk.pick.missing"],
  ...(["role", "scope", "end", "end_past", "duplicate"] as const).map((g) => [{ gaps: [g] }, `access.grant.missing.${g}`] as const),
  [{ when: null }, "access.grant.when.missing"],
  [{ reason: { code: null, memo: "" } }, "uiReason.pick"],
  [{ reason: { code: "OTHER", memo: " \u3000\t" } }, "uiReason.memoRequired"],
] as const)("one missing bulk grant input %j names its reason", (change, id) => {
  expect(bulkBlock({ ...input(), ...change })?.id).toBe(id);
});
test("complete grants need no block, and operating grants need no setup choice", () => {
  expect(bulkBlock(input())).toBeNull();
  expect(bulkBlock({ ...input(), setup: false, when: null })).toBeNull();
});
test("the page's blocked primary remains focusable and its click reveals inline errors without previewing", () => {
  view.picked = 0; view.draft!.reason.code = null;
  const html = render();
  const button = html.match(/<button[^>]*>0명 미리보기<\/button>/)![0];
  expect(button).toContain('aria-disabled="true"');
  expect(button).toContain('type="button"');
  expect(button).not.toMatch(/\sdisabled=/);
  const id = button.match(/aria-describedby="([^"]+)"/)![1];
  const reason = t("access.bulk.pick.missing");
  expect(html).toContain(`id="${id}">${reason}<`);
  expect(html.split(reason)).toHaveLength(2);
  const preventDefault = vi.fn();
  view.buttons.find((p) => p.children === t("access.bulk.preview", { count: 0 }))!.onClick!({ preventDefault } as unknown as MouseEvent<HTMLButtonElement>);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(view.tried).toBe(true);
  const errors = render();
  expect(errors).toContain(`role="alert">${reason}`);
  expect(errors).toContain(t("uiReason.pick", { label: t("access.grant.reason") }));
  expect(view.mutate).not.toHaveBeenCalled();
});
test("a complete grant enables the same page action and previews the picked people", () => {
  const html = render();
  const button = html.match(/<button[^>]*>1명 미리보기<\/button>/)![0];
  expect(button).not.toContain('aria-disabled');
  view.buttons.find((p) => p.children === t("access.bulk.preview", { count: 1 }))!.onClick!({} as MouseEvent<HTMLButtonElement>);
  expect(view.mutate).toHaveBeenCalledExactlyOnceWith(["person"]);
});
test.each(["composer-browser.ts", "composer.fixture.tsx"])("unit composers have no browser harness: %s", (file) => {
  expect(existsSync(new URL(`../../../test/${file}`, import.meta.url))).toBe(false);
});
