// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterAll, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser, type Page } from "@playwright/test";
import { loadCatalog } from "@console/i18n";
import { BlockedPanel } from "./blocked-panel";
let browser: Browser;
let page: Page;
beforeAll(async () => { await loadCatalog("ko"); browser = await chromium.launch(); page = await browser.newPage(); }, 60_000);
afterAll(async () => { await browser?.close(); });
test.each(["terms_not_accepted", "already_operating"])("%s stays hidden until the reason is opened", async (code) => {
  const action = "확인", body = "문서 내용을 확인해 주세요";
  const html = renderToStaticMarkup(<BlockedPanel domain="onboarding" supportRef="00000000-0000-4000-8000-000000000001" title="운영 시작을 확인해 주세요" code={code} unblockers={[{ name: "김관리자" }]} actions={<button>{action}</button>}>{body}</BlockedPanel>);
  await page.setContent(`<main>${html}</main>`);
  expect(await page.locator("body").innerText()).not.toContain(code);
  expect(await page.locator("body").innerText()).not.toContain("ref 00000000");
  await page.getByText("이유 보기", { exact: true }).click();
  expect(await page.locator("details").innerText()).toContain(`onboarding.refuse.${code}`);
  expect(await page.locator("details").innerText()).toContain("ref 00000000");
  expect(await page.locator("body").innerText()).toContain("문서 내용을 확인해 주세요");
});
