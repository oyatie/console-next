// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import { atPhoneWidth, expectAccessible } from "./a11y";
import { go, kstDate, registerEmployee } from "./flows";
import { officeSchedule } from "./helpers/attendance-records";
import { openTenant } from "./helpers/tenant";
import { registerEntity, staffedTenant } from "./setup-flows";
import { forgetResize } from "./stability";

import { roadmap, withoutExceptions } from "../scripts/unserved-copy";
import allow from "../scripts/unserved-copy-allow.json" with { type: "json" };
import { ko } from "../packages/i18n/src/catalogs/ko";

const exceptions = allow.filter((entry) => entry.locale === "ko").map((entry) => ko[entry.id as keyof typeof ko]);

async function controls(page: Page, path: string) {
  expect.soft(withoutExceptions(await page.locator("body").innerText(), exceptions), `${path}: no roadmap text`).not.toMatch(roadmap);
  const reasons = await page.locator("[disabled], [aria-disabled=true]").evaluateAll((elements) => elements
    .filter((element) => element.getClientRects().length > 0)
    .flatMap((element) => (element.getAttribute("aria-describedby") ?? "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? ""))
    .join("\n"));
  expect.soft(withoutExceptions(reasons, exceptions), `${path}: no future-screen refusal`).not.toMatch(roadmap);
  for (const [action, name] of [
    ["가져오기", /가져오기|붙여넣기/],
    ["내보내기", /내보내기|내려받기|^근로자 명부$/],
    ["패스키 등록", /패스키.*등록|등록.*패스키/],
  ] as const) {
    const entries = page.getByRole("button", { name }).or(page.getByRole("link", { name })).filter({ visible: true });
    expect.soft(await entries.count(), `${path}: one ${action}`).toBeLessThanOrEqual(1);
    if (path.startsWith("/org") && action === "가져오기") await expect(entries).toHaveCount(1);
    if (path === "/account" && action === "패스키 등록") await expect(entries).toHaveCount(1);
  }
}

for (const populated of [false, true]) {
  test(`dead controls: ${populated ? "populated" : "empty"} tenant`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
    test.setTimeout(600_000);
    const admin = populated
      ? (await staffedTenant(browser, "deadstaff", "동작점검")).admin
      : await openTenant(browser, "deadempty", "빈계정동작점검");
    let person: string | undefined;
    if (populated) {
      await registerEmployee(admin, { name: "한동작", number: "DEAD-001", unit: "인사부", hired: kstDate(-60) });
      person = new URL(admin.url()).pathname;
      await officeSchedule(admin);
    }
    const paths = [
      ...(person ? [`${person}?act=menu`, person] : []),
      "/account", "/org?view=list", "/org", "/org?view=outline", "/people", "/people/notices",
      "/attendance", "/attendance?tab=day", "/attendance?tab=schedule",
    ];
    for (const path of paths) {
      await go(admin, path);
      if (path.includes("act=menu")) await expect(admin.getByRole("dialog", { name: "발령", exact: true })).toBeVisible();
      await controls(admin, path);
      await admin.setViewportSize({ width: 1440, height: 1000 });
      await forgetResize(admin);
      await expectAccessible(admin, `dead controls desktop ${path}`);
      await atPhoneWidth(admin, async () => {
        await controls(admin, path);
        await expectAccessible(admin, `dead controls phone ${path}`);
      });
    }
    if (!populated) {
      await go(admin, "/org/entities/new");
      await registerEntity(admin, "첫법인동작점검");
      for (const path of ["/org", "/org?view=outline", "/org?view=list"]) {
        await go(admin, path);
        await controls(admin, path);
        await expectAccessible(admin, `dead controls entity without workplaces desktop ${path}`);
        await atPhoneWidth(admin, async () => {
          await controls(admin, path);
          await expectAccessible(admin, `dead controls entity without workplaces phone ${path}`);
        });
        await admin.getByRole("button", { name: "가져오기", exact: true }).click();
        await expect(admin.getByRole("menuitem", { name: "목록 붙여넣기", exact: true })).toBeEnabled();
        await admin.keyboard.press("Escape");
      }
    }
  });
}
