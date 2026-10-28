// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { loadCatalog, t } from "@console/i18n";
import { readDelimited } from "../../apps/web/src/lib/sheet-file";
import { formulaCases } from "../../scripts/fixtures/spreadsheet-cases";
import { homeSetupChecklist } from "../states/home-setup";
import { screens } from "../states/registry";
import { inbox, structure } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";

test.beforeAll(() => loadCatalog("ko"));
for (const setup of [true, false]) test(`${setup ? "setup" : "registry"} CSV downloads neutralize every formula prefix`, async ({ page }) => {
  const fixture = await mockScreen(page, screens[setup ? 0 : 2], "populated");
  const tree = structure(formulaCases.length);
  const departments = tree.entities[0]!.children[0]!.children;
  departments.forEach((node, i) => { node.code = formulaCases[i]!.value; });
  if (setup) {
    tree.phase = "SETUP";
    departments.forEach((node, i) => { node.name = formulaCases[i]!.value; });
    const checklist = homeSetupChecklist("first");
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: checklist });
    await mockRoute(page, "get", "/api/v1/me/action-inbox", { status: 200, json: { ...inbox(0), setup: checklist } });
  }
  await mockRoute(page, "get", "/api/v1/org-structure", { status: 200, json: tree });
  await page.goto(setup ? "/" : "/org?view=list");
  if (!setup) await page.getByRole("button", { name: t("structure.export.open"), exact: true }).click();
  const download = page.waitForEvent("download");
  await (setup ? page.getByRole("button", { name: t("setup.bulk.download"), exact: true }) : page.getByRole("dialog").getByRole("button", { name: t("structureChart.list.download"), exact: true })).click();
  const stream = await (await download).createReadStream();
  const csv = Buffer.concat(await stream.toArray()).toString("utf8");
  expect(csv.startsWith("\uFEFF")).toBe(true);
  const rows = readDelimited(csv.slice(1));
  for (const { value } of formulaCases) expect(rows.some(row => row[4] === "'" + value), JSON.stringify(value)).toBe(true);
  expect(fixture.unexpected).toEqual([]);
  fixture.release();
});
