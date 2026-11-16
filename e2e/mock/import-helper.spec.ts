// SPDX-License-Identifier: LicenseRef-Proprietary
import { setTimeout } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import type { components } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { confirmImportColumns } from "../helpers/import";
import { id } from "./fixtures";
import { mockPeopleImport } from "./people-import";
import { mockRoute } from "./route";

test("column confirmation waits for a slow preview and returns the confirmed run @regression", async ({ page }) => {
  await loadCatalog("ko");
  const fixture = await mockPeopleImport(page, "empty");
  const sheet = "Synthetic roster";
  let requests = 0;
  await mockRoute(page, "post", "/api/v1/employees/import/preview", async () => {
    const confirmed = ++requests > 1;
    // Reproduce a preview that outlasts the default five-second assertion window.
    if (!confirmed) await setTimeout(6_000);
    return { status: 200, json: {
      run_id: id(confirmed ? 4002 : 4001), entity_type: "employee_hr", source_filename: "synthetic.csv", source_sha256: "a".repeat(64),
      input_rows: confirmed ? 1 : 0, candidate_rows: confirmed ? 1 : 0, preserved_rows: 0, sealed_identities: 0,
      columns: [], sample_rows: [], mapping_profile: {}, sheets_needing_mapping: confirmed ? 0 : 1, available_targets: ["name"],
      sheets: [{ name: sheet, status: confirmed ? "mapped" : "needs_confirmation", rows: 1, header_row: 1,
        columns: [{ column: "A", label: "name", target: "name", source: "catalog" }],
        header_candidates: [{ row: 1, cells: [{ column: "A", label: "name" }] }],
      }],
    } satisfies components["schemas"]["EmployeeImportPreviewResponse"] };
  });
  try {
    await page.goto("/people/import");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: t("uiFileDrop.pick"), exact: true }).click();
    await (await chooser).setFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from("name\r\nSynthetic person\r\n") });
    await page.getByRole("button", { name: t("import.preview"), exact: true }).click();
    const confirmed = await confirmImportColumns(page);
    expect(confirmed?.run_id).toBe(id(4002));
    expect(requests).toBe(2);
    await expect(page.getByRole("button", { name: t("import.dryRun"), exact: true })).toBeEnabled();
    expect(fixture.unexpected).toEqual([]);
  } finally { await page.close(); fixture.release(); }
});
