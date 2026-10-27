// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "@playwright/test";
import { ApiError } from "../../../reference/statutory/api";
import { loadCatalog, t } from "@console/i18n";
import { FIXED_TERM_GROUNDS } from "../domain/fixed-term";
import { LifecycleRefusal } from "./lifecycle-refusal";

let browser: Browser;
let page: Page;
beforeAll(async () => {
  await loadCatalog("ko");
  browser = await chromium.launch();
  page = await browser.newPage();
}, 60_000);
afterAll(async () => { await browser?.close(); });

test.each(["fixed_term_limit", "fixed_term_basis_unconfirmed"] as const)("%s announces one refusal and keeps its reason, remedies and support reference", async (code) => {
  const message = "요청한 계약 종료일은 기간제 근로 한도를 넘습니다.";
  const supportRef = "00000000-0000-4000-8000-000000000001";
  const error = new ApiError(409, code, message, [], undefined, true, [], { supportRef });
  const noop = () => {};
  const html = renderToStaticMarkup(<LifecycleRefusal error={error} kind="CONTRACT_RENEWAL" onLeave={false} target="" onCancelEvent={noop} onClose={noop} onFocusTarget={noop} />);
  await page.setContent(`<main>${html}</main>`);

  const refusal = page.getByRole("alert");
  expect(await refusal.count()).toBe(1);
  expect(await refusal.getByRole("heading", { name: t("lifecycle.blocker.fixedTerm.title"), exact: true }).count()).toBe(1);
  expect(await refusal.innerText()).toContain(code === "fixed_term_limit" ? message : t("exit.error.fixed_term_basis_unconfirmed"));
  expect(await refusal.innerText()).toContain(t(code === "fixed_term_limit" ? "lifecycle.blocker.fixedTerm.body" : "lifecycle.fixedTerm.basisUnconfirmed"));
  for (const ground of FIXED_TERM_GROUNDS) expect(await refusal.innerText()).toContain(t(`lifecycle.fixedTerm.ground.${ground}`));
  expect(await refusal.innerText()).toContain(t("lifecycle.blocker.fixedTerm.exception"));
  expect(await refusal.getByRole("button", { name: t("lifecycle.blocker.fixedTerm.fix"), exact: true }).isVisible()).toBe(true);

  const reference = refusal.locator(`[data-support-reference="${supportRef}"]`);
  expect(await reference.count()).toBe(1);
  expect(await reference.isVisible()).toBe(false);
  await refusal.getByText(t("uiBlocker.reason"), { exact: true }).click();
  expect(await reference.isVisible()).toBe(true);
  expect(await refusal.locator("details").innerText()).toContain(`hr.refuse.${code}`);
});
