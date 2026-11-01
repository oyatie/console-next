// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { PermissionGrid } from "./permission-grid";

beforeAll(() => loadCatalog("ko"));
test("matrix cells are labelled checkboxes, including implied view, without a roadmap footnote", () => {
  const html = renderToStaticMarkup(<PermissionGrid domains={[
    { domain: "hr_basic", grantable: true, levels: ["view", "edit"], operations: [{ operation: "edit", level: "edit" }] },
    { domain: "pay", grantable: true, levels: ["view"], operations: [] },
  ]} value={{ hr_basic: ["edit"] }} routed={new Set()} onChange={() => {}} />);
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html.match(/checked=""/g)).toHaveLength(2);
  expect(html).toContain(t("access.grid.auto"));
  expect(html).not.toContain("aria-pressed");
  expect(html).not.toContain("아직 없음");
  const labels = html.match(/<label class="check">.*?<\/label>/g)!;
  expect(labels.map(label => label.replace(/<[^>]*>/g, ""))).toEqual([t("access.grid.auto"), ""]);
});
