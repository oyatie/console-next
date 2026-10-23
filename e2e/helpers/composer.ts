// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Locator } from "@playwright/test";

/** Check the public composer contract without depending on its layout or implementation constants. */
export async function expectComposer(composer: Locator, outcome: string) {
  const order = ["사전 확인", "효과", "결재선", "서류", "법정 기한", "할 일", "권한 변경", "급여 영향"];
  const titles = await composer.locator("[data-composer-section] > :is(h2, h3)").allTextContents();
  expect(titles.length).toBeGreaterThan(0);
  expect(titles).toEqual(order.filter((title) => titles.includes(title)));
  await expect(composer.getByRole("button", { name: outcome, exact: true })).toBeVisible();
  await expect(composer.getByRole("button", { name: "닫기", exact: true }).last()).toBeVisible();
  await expect(composer.getByRole("button", { name: /반영 · 항목|^0명|시행$/ })).toHaveCount(0);
}
