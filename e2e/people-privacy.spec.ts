// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { clearShifts, forgetResize } from "./stability";
import { expectAccessible } from "./a11y";
import { go } from "./flows";
import { setupCompany } from "./setup-flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { chooseWorkbook } from "./helpers/import";
import { rrn, workbook } from "./helpers/import-layouts";

// Slices 1–3: one policy, a bound passkey and an accountable field reveal.
test("solo: RRN and birth-date reveals use passkeys and remask on the card and identifiers", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "peopleprivacy", "정보정밀");
  await setupCompany(admin, "정보정밀", "본사");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/people/import");
  await chooseWorkbook(admin, "privacy.xlsx", await workbook([{ name: "명부", lines: [
    ["사번", "성명", "주민등록번호", "생년월일", "입사일"],
    ["PR-0001", "한기록", rrn("1990-01-01", 1, 1), "1990-01-01", "2024-01-02"],
  ] }]));
  await admin.getByRole("button", { name: "명부 미리보기" }).click();
  await admin.getByRole("button", { name: "모의 반영 실행" }).click();
  await admin.getByRole("button", { name: "명부 반영: 신규 1명 · 갱신 0명", exact: true }).click();
  await expect(admin.getByRole("heading", { name: /명부를 반영했습니다|반영했습니다/ })).toBeVisible();
  const result = await api("/employees?employee_number=PR-0001");
  expect(result.ok()).toBe(true);
  const { items } = await result.json() as { items: { id: string }[] };
  expect(items).toHaveLength(1);
  const id = items[0]!.id;
  const status = await (await api(`/employees/${id}/rrn`)).json() as { masked: string };
  expect(status.masked).toBe("••••••-•••••••");
  for (const width of [1440, 390]) {
    await admin.setViewportSize({ width, height: 1000 });
    await forgetResize(admin);
    for (const suffix of ["", "/identifiers"]) {
      await go(admin, `/people/${id}${suffix}`);
      await expect(admin.getByText(status.masked, { exact: true })).toBeVisible();
      if (!suffix) {
        const birth = admin.locator("#f-birth_date");
        await expect(birth).toContainText("••••-••-••");
        await expect(birth).not.toContainText("1990");
        await birth.getByRole("button", { name: /보기/ }).click();
        await admin.getByRole("dialog").getByText("본인 확인", { exact: true }).click();
        const opened = admin.waitForResponse(r => r.url().endsWith(`/employees/${id}/reveal`) && r.request().method() === "POST");
        await admin.getByRole("dialog").getByRole("button", { name: "보기", exact: true }).click();
        const response = await opened;
        expect(response.ok()).toBe(true);
        expect(response.headers()["cache-control"]).toContain("no-store");
        await expect(birth).toContainText("1990");
        await birth.getByRole("button", { name: "가리기", exact: true }).click();
        await expect(birth).toContainText("••••-••-••");
        for (const field of ["#f-address", "#s1"]) await expect(admin.locator(field).getByText(/아직 서버/)).toHaveCount(0);
      }
      const rrnRow = suffix ? admin.getByRole("region", { name: "주민등록번호", exact: true })
        : admin.getByRole("region", { name: "인적사항", exact: true }).getByText("주민등록번호", { exact: true }).locator("..");
      await admin.getByRole("button", { name: "주민등록번호 보기 · 사유를 선택합니다", exact: true }).click();
      await admin.getByRole("dialog").getByText("본인 확인", { exact: true }).click();
      await admin.evaluate(() => document.fonts.ready);
      await admin.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      const maskedHeight = (await rrnRow.boundingBox())!.height;
      await admin.evaluate(clearShifts);
      const layout = await admin.evaluateHandle(() => {
        const shifts: number[] = [];
        const observer = new PerformanceObserver(list => {
          shifts.push(...list.getEntries().map(entry => (entry as PerformanceEntry & { value: number }).value));
        });
        observer.observe({ type: "layout-shift" });
        return { shifts, observer };
      });
      const opened = admin.waitForResponse(r => r.url().endsWith(`/employees/${id}/rrn/reveal`) && r.request().method() === "POST");
      await admin.getByRole("dialog").getByRole("button", { name: "보기", exact: true }).click();
      const response = await opened;
      expect(response.ok()).toBe(true);
      const { display_seconds } = await response.json() as { display_seconds: number };
      const timer = admin.getByRole("timer");
      await expect(timer).toBeVisible();
      const heightDelta = (await rrnRow.boundingBox())!.height - maskedHeight;
      expect(heightDelta, `RRN row height delta at ${width}px on ${suffix || "card"}`).toBe(0);
      // Include the reveal's real paint before reading the observer.
      await admin.screenshot();
      const shiftScore = await layout.evaluate(({ shifts, observer }) => {
        shifts.push(...observer.takeRecords().map(entry => (entry as PerformanceEntry & { value: number }).value));
        observer.disconnect();
        return shifts.reduce((sum, value) => sum + value, 0);
      });
      await layout.dispose();
      expect(shiftScore, `RRN reveal layout shift at ${width}px on ${suffix || "card"}`).toBe(0);
      await test.info().attach(`rrn-layout-${suffix || "card"}-${width}`, { body: JSON.stringify({ width, heightDelta, shiftScore }), contentType: "application/json" });
      for (const item of [timer, admin.getByRole("button", { name: "가리기", exact: true })]) {
        expect(await item.evaluate(el => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight))).toBeLessThan(2);
      }
      await admin.clock.setSystemTime((await admin.evaluate(() => Date.now())) + display_seconds * 1000 + 1);
      await expect(admin.getByText(status.masked, { exact: true })).toBeVisible();
      await admin.clock.setSystemTime(Date.now());
      expect((await rrnRow.boundingBox())!.height).toBe(maskedHeight);
      for (const theme of ["light", "dark"]) {
        await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        const body = await admin.locator("body").innerText();
        expect(body).not.toMatch(/\d{6}-\d|●|아직 서버/);
        await test.info().attach(`rows-948-940-${suffix ? "identifiers" : "card"}-${width}-${theme}`, { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
      }
      await expectAccessible(admin, `privacy ${suffix || "card"} ${width}`);
    }
  }
});
