// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { Sheet } from "../../../ui/sheet/sheet";
import type { BizKind } from "@console/api/pending";
import { quickBlock } from "../domain/create";
import { emptyDraft } from "../domain/draft";
import { EntityQuickSheet } from "./entity-quick-sheet";

const view = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const i = view.cursor++;
    return i < view.values.length ? [view.values[i], vi.fn()] : actual.useState(initial);
  } };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [] } }) }));
vi.mock("@tanstack/react-router", async (original) => ({ ...await original<typeof import("@tanstack/react-router")>(), useNavigate: () => vi.fn() }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({}) }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: (p: Parameters<typeof Sheet>[0]) => <>{p.consequence}{p.actions}</> }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.cursor = 0; view.values = [null, "", "", "", ""]; });
const draft = () => ({ ...emptyDraft(), bizKind: "INDIVIDUAL" as BizKind | null, name: "Acme", representatives: ["Kim"] });
test.each([
  [{ bizKind: null }, "entityQuick.hold.basics"],
  [{ name: " \u3000" }, "entityQuick.hold.basics"],
  [{ representatives: [""] }, "entityQuick.hold.basics"],
  [{ bizKind: "CORPORATION" }, "entityQuick.hold.corp"],
  [{ name: "Kim" }, "entity.refusal.legal_name_is_person"],
  [{ displayName: "Kim" }, "entity.refusal.display_name_is_person"],
  [{ englishName: "Kim" }, "entity.refusal.english_name_is_person"],
  [{ englishName: "상사" }, "entity.refusal.english_name_not_latin"],
] as const)("quick entity refusal %j names its reason", (change, id) => {
  expect(quickBlock({ ...draft(), ...change, representatives: [...("representatives" in change ? change.representatives : draft().representatives)] })).toBe(id);
});
test("complete entity basics need no block", () => expect(quickBlock(draft())).toBeNull());
test("a held entity primary explains itself once and offers no second disabled save", () => {
  const html = renderToStaticMarkup(<EntityQuickSheet open onClose={vi.fn()} onSaved={vi.fn()} />);
  const button = html.match(/<button[^>]*>법인 등록<\/button>/)![0];
  expect(button).toContain('aria-disabled="true"');
  expect(button).toContain('type="button"');
  expect(button).not.toMatch(/\sdisabled=/);
  const id = button.match(/aria-describedby="([^"]+)"/)![1];
  const reason = t("entityQuick.hold.basics");
  expect(html).toContain(`id="${id}">${reason}<`);
  expect(html.split(reason)).toHaveLength(2);
  expect(html).not.toContain(t("entityQuick.createAndWorkplace"));
});
test("complete entity basics enable both save paths", () => {
  view.values = ["INDIVIDUAL", "Acme", "Kim", "", ""];
  const html = renderToStaticMarkup(<EntityQuickSheet open onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(html).not.toContain('aria-disabled');
  expect(html).toContain(t("entityQuick.createAndWorkplace"));
});
