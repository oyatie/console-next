// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { koDate } from "../flows";
import { clearShifts } from "../stability";

/** Uses the enrolled passkey and real HTTP; only Date advances so input/paint timing stays native. */
export async function expectGovernedBirthReveal(page: Page, field: Locator, birth: string) {
  const endpoint = /\/api\/v1\/employees\/[^/]+\/reveal$/;
  let release = () => {};
  const held = new Promise<void>(done => { release = done; });
  await page.route(endpoint, async route => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await expect(field).toContainText("••••-••-••");
    await field.getByRole("button", { name: "생년월일 보기 · 사유를 선택합니다", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "보기", exact: true })).toBeDisabled();
    await dialog.getByText("본인 확인", { exact: true }).click();
    const stepped = page.waitForResponse(r => r.url().endsWith("/auth/passkey/step-up/start") && r.request().method() === "POST");
    const posted = page.waitForRequest(endpoint);
    const opened = page.waitForResponse(endpoint);
    await dialog.getByRole("button", { name: "보기", exact: true }).click();
    expect((await stepped).ok()).toBe(true);
    const request = await posted;
    const id = new URL(request.url()).pathname.split("/").at(-2)!;
    expect(request.method()).toBe("POST");
    expect(request.postDataJSON()).toMatchObject({
      field: "BIRTH_DATE", reason_code: "IDENTITY_VERIFICATION",
      step_up: {
        binding: { action_kind: "PII_REVEAL", object_id: id, payload_hash: createHash("sha256").update("BIRTH_DATE:IDENTITY_VERIFICATION").digest("hex") },
        assertion: { ceremony_id: expect.any(String), credential: { id: expect.any(String) } },
      },
    });
    await expect(field).not.toContainText(koDate(birth));
    await expect(field).toContainText("••••-••-••");
    release();
    const response = await opened;
    expect(response.ok()).toBe(true);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const { display_seconds } = await response.json() as { display_seconds: number };
    expect(display_seconds).toBeGreaterThan(0);
    await expect(field).toContainText(koDate(birth));
    await expect(field.getByRole("timer")).toBeVisible();
    await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + display_seconds * 1000 + 1);
    await expect(field).toContainText("••••-••-••");
    await expect(field).not.toContainText(koDate(birth));
    await expect(field.getByRole("button", { name: "생년월일 보기 · 사유를 선택합니다", exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.evaluate(clearShifts);
  } finally {
    release();
    await page.unroute(endpoint);
    await page.clock.setSystemTime(Date.now());
  }
}
