// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { Node, Place } from "../../../reference/org/domain/structure";
import { DeptAddGovernedSheet } from "./dept-add-governed-sheet";

const { submit } = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock("./use-govern", () => ({
  useGovern: () => ({ missing: [], words: { submit: () => "" } }),
  useGovernSubmit: (build: () => unknown) => { submit(build()); return {}; },
}));
// Inspect the proposal the real sheet builds; rendering its unrelated form is unnecessary.
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: () => null }));
beforeAll(() => loadCatalog("ko"));

test("creating under a workplace keeps its panel selected by the chart ID", () => {
  const node: Node = { id: "chart-parent", org_unit_id: "backing-unit", kind: "WORKPLACE", name: "parent", children: [], headcount: 0, direct_headcount: 0, dispatched_headcount: 0, chips: [] };
  const place: Place = { node, entity: node, path: [], workplace: node };
  renderToStaticMarkup(<DeptAddGovernedSheet place={place} onClose={() => undefined} />);
  expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({
    target: expect.objectContaining({ ref: "backing-unit" }),
    select: "chart-parent",
    proposal: [expect.objectContaining({ parentId: "backing-unit" })],
  }));
});
