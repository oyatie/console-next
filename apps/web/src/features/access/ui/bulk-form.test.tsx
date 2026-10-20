// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { composerBrowser } from "../../../test/composer-browser";

beforeAll(() => loadCatalog("ko"));
const browser = composerBrowser();

test("primary commit blocks each missing requirement independently and recovers after a memo edit", async () => {
  const reasons = {
    people: t("access.bulk.pick.missing"),
    role: t("access.grant.missing.role"), scope: t("access.grant.missing.scope"),
    end: t("access.grant.missing.end"), end_past: t("access.grant.missing.end_past"), duplicate: t("access.grant.missing.duplicate"),
    when: t("access.grant.when.missing"), code: t("uiReason.pick", { label: t("access.grant.reason") }), memo: t("uiReason.memoRequired"),
  };
  const commit = browser.page.getByRole("button", { name: /명 미리보기/ });
  for (const absent of Object.keys(reasons) as (keyof typeof reasons)[]) {
    await browser.mount({ sheet: "access", absent });
    await browser.blocked(commit, reasons[absent]);
  }
  await browser.page.getByRole("textbox", { name: /메모/ }).fill("한글 사유");
  expect(await commit.getAttribute("aria-disabled")).toBeNull();
  await commit.click();
  expect(await browser.page.evaluate(() => window.composerCommits)).toBe(1);
});
