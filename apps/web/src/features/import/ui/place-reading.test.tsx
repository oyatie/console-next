// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createElement, type MouseEvent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog, t } from "@console/i18n";
import type { Button } from "../../../ui/button/button";
import type { ImportPreview } from "../domain/contract";
import type { Mapping } from "../domain/mapping";
import { initialPicks } from "../domain/steps";
import { PreviewStep } from "./preview-step";

const buttons = vi.hoisted(() => [] as Parameters<typeof Button>[0][]);
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { buttons.push(props); return createElement(actual.Button, props); } };
});
afterEach(() => { buttons.length = 0; });
beforeAll(() => loadCatalog("ko"));

const html = (node: ReactNode) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const noop = () => undefined;
const placePreview: ImportPreview = {
  run_id: "place-run",
  entity_type: "employee_hr",
  source_filename: "place-readings.xlsx",
  source_sha256: "a".repeat(64),
  input_rows: 3,
  candidate_rows: 3,
  preserved_rows: 0,
  columns: [{ source_header: "사용장소", normalized_header: "사용장소", target: null, classification: "canonical", preview_allowed: true, place_reading_required: true }],
  sample_rows: [],
  mapping_profile: {},
  sheets: ["직원", "추가 직원"].map((name) => ({
    name, status: "needs_mapping", rows: 3, header_row: 2,
    columns: [
      { column: "A", label: "성명", target: "name", source: "catalog" },
      { column: "B", label: "사용장소", target: null, source: "catalog" },
    ],
  })),
  sheets_needing_mapping: 2,
  available_targets: ["name", "workplace", "worksite_name"],
  sealed_identities: 0,
};

test.each([["workplace", "import.place.workplace"], ["worksite_name", "import.place.worksite"]] as const)("the explicit %s reading remaps only its sheet and keeps other sheet decisions", (target, label) => {
  const onRemap = vi.fn();
  const mapping: Mapping = { 메모: { skip: true } };
  const out = html(<PreviewStep preview={placePreview} picks={initialPicks()} mapping={mapping} rereading={false} onRemap={onRemap} onDryRun={noop} onExpired={noop} onRestart={noop} />);
  const choices = buttons.filter((button) => [t("import.place.workplace"), t("import.place.worksite")].includes(String(button.children)));
  expect(choices).toHaveLength(4);
  expect(out).toContain(t("import.block.sheets", { count: 2 }));
  choices.find((button) => button.children === t(label))!.onClick!({} as MouseEvent<HTMLButtonElement>);
  expect(onRemap).toHaveBeenCalledWith({ ...mapping, 직원: { header_row: 2, columns: { A: "name", B: target } } });
});

test("place-reading choices stay disabled while the file is being read again", () => {
  html(<PreviewStep preview={placePreview} picks={initialPicks()} mapping={{}} rereading onRemap={noop} onDryRun={noop} onExpired={noop} onRestart={noop} />);
  const choices = buttons.filter((button) => [t("import.place.workplace"), t("import.place.worksite")].includes(String(button.children)));
  expect(choices).toHaveLength(4);
  expect(choices.every((button) => button.disabled)).toBe(true);
});

test.each([
  ["workplace", "import.place.workplace", "worksite_name", "import.place.worksite"],
  ["worksite_name", "import.place.worksite", "workplace", "import.place.workplace"],
] as const)("a reading cannot duplicate the existing %s target while the other reading still works", (existing, blockedLabel, alternative, alternativeLabel) => {
  const onRemap = vi.fn();
  const mapping: Mapping = { 메모: { skip: true } };
  const source = placePreview.sheets[0]!;
  const p: ImportPreview = {
    ...placePreview,
    sheets: [{ ...source, columns: [...source.columns!, { column: "C", label: "연결한 장소", target: existing, source: "operator" }] }],
    sheets_needing_mapping: 1,
    available_targets: ["name", "workplace", "worksite_name"],
  };
  const out = html(<PreviewStep preview={p} picks={initialPicks()} mapping={mapping} rereading={false} onRemap={onRemap} onDryRun={noop} onExpired={noop} onRestart={noop} />);
  const blocked = buttons.find((button) => button.children === t(blockedLabel))!;
  const event = { preventDefault: vi.fn() };
  blocked.onClick!(event as unknown as MouseEvent<HTMLButtonElement>);
  expect(onRemap).not.toHaveBeenCalled();
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(blocked["aria-disabled"]).toBe(true);
  expect(blocked.disabled).not.toBe(true);
  expect(out).toContain(`id="${blocked["aria-describedby"]}"`);
  expect(out).toContain(t("importSheet.map.problem.duplicate"));

  const valid = buttons.find((button) => button.children === t(alternativeLabel))!;
  expect(valid["aria-disabled"]).not.toBe(true);
  valid.onClick!({} as MouseEvent<HTMLButtonElement>);
  expect(onRemap).toHaveBeenCalledWith({ ...mapping, 직원: { header_row: 2, columns: { A: "name", B: alternative, C: existing } } });
});
