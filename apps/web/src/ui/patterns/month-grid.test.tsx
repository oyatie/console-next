// SPDX-License-Identifier: LicenseRef-Proprietary
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { MonthGridPattern } from "./month-grid";
import { monthGridOptionalRegions } from "./month-grid-contract";
import { assertPatternLifecycle, makeHead, makeTabs, mark, notFoundRead, readyRead, renderPatternMarkup } from "./pattern-test-helpers";

beforeAll(() => loadCatalog("ko"));

test("MonthGridPattern satisfies placement, refusal, loading, and 404 data-detail contracts", async () => {
  const renderGrid = (q = readyRead) => (
    <MonthGridPattern
      q={q}
      head={makeHead("month-contract-title", { filters: mark("filters"), tools: mark("tools") })}
      tabs={makeTabs()}
      summary={mark("summary")}
      notes={mark("notes")}
      grid={mark("grid")}
      bottom={mark("bottom")}
      record={{ id: "day-1", label: "Day detail", onClose() {}, children: mark("record") }}
      foot={mark("foot")}
      facts={mark("facts")}
      overlays={mark("overlays")}
    />
  );

  await assertPatternLifecycle({
    pattern: "month-grid",
    optionalRegions: monthGridOptionalRegions,
    render: renderGrid,
    placed: ["head", "asOf", "tabs", "filters", "tools", "summary", "notes", "grid", "bottom", "record", "foot", "overlays"],
    stripped: ["asOf", "filters", "tools", "summary", "notes", "grid", "bottom", "record", "foot", "facts", "overlays"],
    withheld: ["summary", "grid", "bottom", "record"],
  });

  const notFound = await renderPatternMarkup(renderGrid(notFoundRead("missing-month")));
  expect(notFound).not.toContain("data-detail");
});
