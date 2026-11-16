// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { createElement, type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import type { Button } from "../../../ui/button/button";
import type { ImportSheet } from "../domain/contract";
import { draftOf, draftProblem, withTarget } from "../domain/mapping";
import { SheetEditor } from "./sheet-editor";

const buttons = vi.hoisted(() => [] as Parameters<typeof Button>[0][]);
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { buttons.push(props); return createElement(actual.Button, props); } };
});
beforeAll(() => loadCatalog("ko"));
const sheet: ImportSheet = {
  name: "Synthetic", status: "needs_confirmation", rows: 3, header_row: 1,
  columns: [{ column: "A", label: "name", target: "name", source: "catalog" }, { column: "B", label: "workplace", target: "workplace", source: "catalog" }],
};

test.each(["workplace", "worksite_name"])("the column editor confirms %s without a second place-reading control", (target) => {
  buttons.length = 0;
  const onSave = vi.fn();
  const mapped = { ...sheet, columns: sheet.columns!.map(c => c.column === "B" ? { ...c, target } : c) };
  const out = renderToStaticMarkup(<SheetEditor sheet={mapped} targets={["name", "workplace", "worksite_name"]} busy={false} onSave={onSave} />);
  expect(out).toContain('value="workplace"');
  expect(out).toContain('value="worksite_name"');
  expect(out).not.toContain("법인 사업장으로 읽기");
  expect(out).not.toContain("근무지(고객 현장)로 읽기");
  const save = buttons.find(b => b.children === t("importSheet.map.save", { name: sheet.name }))!;
  save.onClick!({} as MouseEvent<HTMLButtonElement>);
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ columns: expect.arrayContaining([expect.objectContaining({ column: "B", target })]) }));
});

test("confirmation stays disabled while rereading", () => {
  buttons.length = 0;
  renderToStaticMarkup(<SheetEditor sheet={sheet} targets={["name", "workplace", "worksite_name"]} busy onSave={vi.fn()} />);
  expect(buttons.find(b => b.children === t("importSheet.map.save", { name: sheet.name }))!.disabled).toBe(true);
});

test.each(["workplace", "worksite_name"])("a place binding cannot duplicate an existing %s target", (target) => {
  const draft = draftOf({ ...sheet, columns: [...sheet.columns!, { column: "C", label: "Site", target, source: "operator" }] });
  expect(draftProblem(withTarget(draft, "B", target))).toBe("duplicate");
  expect(draftProblem(withTarget(draft, "B", target === "workplace" ? "worksite_name" : "workplace"))).toBeNull();
});
