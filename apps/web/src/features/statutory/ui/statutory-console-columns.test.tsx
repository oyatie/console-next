// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { FilingTask } from "../../../reference/statutory/api";
import { buildFilingColumns } from "./statutory-console-columns";

beforeAll(() => loadCatalog("ko"));

const task = { event_id: "evt-1", employee_id: "emp-1", name: "Filer One", kind: "ACQUIRE", insurer: "NPS", state: "OPEN", record_action: "RECORD" } as unknown as FilingTask;

// The row opens its filing in the pane; a row button that says "record" but opens the pane names one action for another.
test("the filing row's command opens the filing, named for the person and the filing it opens", () => {
  const action = buildFilingColumns(vi.fn()).find(c => c.id === "action")!;
  expect(renderToStaticMarkup(<>{action.header}</>)).toBe(`<span class="sr-only">${t("statutory.openCol")}</span>`);
  const button = renderToStaticMarkup(<>{action.cell(task)}</>);
  expect(button).toContain(`aria-label="${t("statutory.openRow", { name: "Filer One", insurer: t("statutory.NPS"), kind: t("statutory.ACQUIRE") })}"`);
  expect(button).toContain(`>${t("statutory.openCol")}</button>`);
  expect(button).not.toContain(t("statutory.record"));
});
