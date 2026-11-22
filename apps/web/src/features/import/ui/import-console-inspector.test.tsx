// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToReadableStream } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { ImportDryRun, ImportRow, ReviewItem } from "../domain/contract";
import { initialPicks } from "../domain/steps";
import { ImportConsoleInspector } from "./import-console-inspector";

beforeAll(() => loadCatalog("ko"));

const noop = () => undefined;
const row = (over: Partial<ImportRow>): ImportRow => ({
  source_key: `k${over.row ?? 2}`,
  sheet: "SheetA",
  row: 2,
  name: "Sample",
  outcome: "update",
  ...over,
});

async function inspectHtml(props: {
  currentItem?: ReviewItem;
  activeRow?: ImportRow;
  rows?: ImportRow[];
  sexMapped?: boolean;
}) {
  const dryRun: ImportDryRun = {
    rows: props.rows ?? [],
    review: {
      items: props.currentItem ? [props.currentItem] : [],
      count: props.currentItem ? 1 : 0,
      blocking: props.currentItem?.blocking ? 1 : 0,
    },
    remembered: [],
    decisions: {},
  } as unknown as ImportDryRun;
  const stream = await renderToReadableStream(
    <QueryClientProvider client={new QueryClient()}>
      <ImportConsoleInspector
        dry={dryRun}
        picks={initialPicks()}
        currentItem={props.currentItem}
        activeRow={props.activeRow}
        sexMapped={props.sexMapped ?? false}
        busy={false}
        onResolve={noop}
        onSheets={noop}
      />
    </QueryClientProvider>,
  );
  await stream.allReady;
  return new Response(stream).text();
}

test("inspector isolates item remediation hints from an unrelated valid active row and avoids same-row duplicates", async () => {
  const invalidDateItem = {
    id: "excl-5",
    reason: "invalid_date",
    blocking: true,
    sheet: "SheetA",
    row: 5,
    rows: 1,
    resolution: { decision: "exclusions", key: "SheetA:5", choices: [] },
  } as unknown as ReviewItem;
  const invalidRow = row({ row: 5, name: "Row5 Person", outcome: "refused", refusal_code: "invalid_date", refusal_field: "hire_date" });
  const preHireRow = row({
    row: 2,
    name: "Row2 Person",
    outcome: "insert",
    new_person: { status: "PRE_HIRE", id_type: "NOT_ISSUED", hire_date: "2026-12-01", migrated_former: false, employee_number: "10701", sex: "MALE" },
  });

  const out = await inspectHtml({
    currentItem: invalidDateItem,
    activeRow: preHireRow,
    rows: [preHireRow, invalidRow],
    sexMapped: false,
  });
  const hint = t("importReview.hint.invalid_date");
  expect(out.split(hint)).toHaveLength(2);
  const rowLabel = t("import.rows.detail", { sheet: "SheetA", row: 2, name: "Row2 Person" });
  const detailStart = out.indexOf(`aria-label="${rowLabel}"`);
  expect(detailStart).toBeGreaterThan(-1);
  const detailSlice = out.slice(detailStart);
  expect(detailSlice).toContain(t("enum.idType.NOT_ISSUED"));
  expect(detailSlice).toContain(t("import.rows.preHireBadge"));
  expect(detailSlice).toContain(t("import.rows.sexDerived", { sex: t("import.sex.MALE") }));
  expect(detailSlice).not.toContain(hint);

  const preHireWithRrn = row({
    row: 6,
    name: "Row6 Person",
    outcome: "insert",
    new_person: { status: "PRE_HIRE", id_type: "DOMESTIC_RESIDENCE", hire_date: "2026-12-01", migrated_former: false, employee_number: "10702", sex: "FEMALE" },
  });
  const preHireRrnOut = await inspectHtml({
    activeRow: preHireWithRrn,
    rows: [preHireWithRrn],
    sexMapped: false,
  });
  expect(preHireRrnOut).toContain(t("enum.idType.DOMESTIC_RESIDENCE"));
  expect(preHireRrnOut).not.toContain(t("import.rows.preHireBadge"));
  expect(preHireRrnOut).toContain(t("import.rows.sexDerived", { sex: t("import.sex.FEMALE") }));
  expect(preHireRrnOut).not.toContain("<p class=");

  const sameRowOut = await inspectHtml({
    currentItem: invalidDateItem,
    activeRow: invalidRow,
    rows: [preHireRow, invalidRow],
    sexMapped: false,
  });
  expect(sameRowOut.split(hint)).toHaveLength(2);

  const unitItem = {
    id: "unit-3",
    reason: "unit_unmapped",
    blocking: true,
    sheet: "SheetA",
    row: 3,
    rows: 1,
    value: "UnknownTeam",
    resolution: { decision: "unit_map", key: "UnknownTeam", choices: [] },
  } as unknown as ReviewItem;
  const conflictRow = row({ row: 4, name: "Row4 Person", outcome: "refused", refusal_code: "status_conflict" });
  const conflictOut = await inspectHtml({
    currentItem: unitItem,
    activeRow: conflictRow,
    rows: [conflictRow],
    sexMapped: false,
  });
  const conflictStart = conflictOut.indexOf(`aria-label="${t("import.rows.detail", { sheet: "SheetA", row: 4, name: "Row4 Person" })}"`);
  expect(conflictStart).toBeGreaterThan(-1);
  expect(conflictOut.slice(conflictStart)).toContain(t("importReview.hint.status_conflict"));
});
