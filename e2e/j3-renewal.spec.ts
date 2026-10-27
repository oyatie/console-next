import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, koDate, kstDate, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";
import { reasonBox, sheet } from "./sheet";
import { holdRead } from "./helpers/read";

// J3 계약 갱신: contracts ending soon queue on Home; one link opens the renewal sheet, and its receipt opens the
// next renewal in the same queue (away from the commit).
test("J3 contract renewal from Home's queue, then the next one", { tag: "@hr" }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "j3co", "갱신주식회사");
  const c = clickCounter();
  await registerEmployee(admin, { name: "을계약", number: "J3-0002", contractEnd: kstDate(30) });
  const nextEmployee = new URL(admin.url()).pathname.replace("/people/", "/api/v1/employees/");
  const nextContracts = `**${nextEmployee}/contracts`;
  await registerEmployee(admin, { name: "갑계약", number: "J3-0001", contractEnd: kstDate(20) });
  await expect(admin.getByRole("region", { name: "재직·배치" }).getByText("D-20")).toBeVisible();

  await go(admin, "/");
  const queue = admin.getByRole("region", { name: "업무함", exact: true }).getByRole("row").filter({ hasText: "갑계약" }).filter({ has: admin.getByRole("link", { name: "계약 갱신", exact: true }) });
  await expect(queue).toContainText("갑계약");
  await expectAccessible(admin, "J3: Home renewal queue");
  await c.click(queue.getByRole("link", { name: "계약 갱신", exact: true }));
  const renewal = sheet(admin, "갑계약 계약 갱신");
  await expect(renewal).toBeVisible();
  await expectAccessible(admin, "J3: renewal sheet opened from Home");
  // The foot states the act and its date (spec E5); nothing is counted as a gate.
  // One press sets both dates for a whole period from the day after the current contract (nothing chosen before).
  await c.click(renewal.getByRole("button", { name: /^다음 날부터 1년 · / }));
  await reasonBox(renewal).fill("계약 1년 연장");
  // It starts after today: a reservation, blue.
  const commit = renewal.getByRole("button", { name: "계약 갱신 1명 예약", exact: true });
  await expect(commit).toHaveClass(/btn--primary/);
  const recorded = admin.waitForResponse((response) => response.url().endsWith("/lifecycle-events") && response.request().method() === "POST");
  await c.click(commit);
  expect((await recorded).ok()).toBe(true);
  await expect(renewal).toBeHidden();
  const history = admin.getByRole("region", { name: "인사 이력" });
  await expect(history.getByRole("listitem").filter({ hasText: /갑계약의 계약을 .+까지 갱신하도록 예약했습니다/ })).toBeVisible();
  await expect(history.getByRole("status")).toContainText("갑계약님의 계약 갱신을");
  // Base 2 (queue row, commit) + 1 period preset for both dates; no statement to tick (BW-11 A13).
  expect(c.done("J3 renew from queue")).toBeLessThanOrEqual(3);

  // The receipt offers the next renewal in Home's queue; it opens that person's renewal sheet directly.
  const contracts = await holdRead(admin, nextContracts);
  const person = await holdRead(admin, `**${nextEmployee}`);
  await history.getByRole("link", { name: "다음 갱신 열기 (1건 남음)" }).click();
  await Promise.all([contracts.requested, person.requested]);
  try {
    await expect(sheet(admin, "을계약 계약 갱신")).toBeHidden();
    await expectAccessible(admin, "J3: cached next employee waits for a fresh contract read");
    const answered = admin.waitForResponse((r) => new URL(r.url()).pathname === `${nextEmployee}/contracts`);
    await contracts.release();
    await answered;
    await expectAccessible(admin, "J3: invalidated employee waits for its fresh record after contracts settle");
    await expect(sheet(admin, "을계약 계약 갱신")).toBeHidden();
  } finally {
    await Promise.all([contracts.release(), person.release()]);
  }
  await expect(sheet(admin, "을계약 계약 갱신")).toBeVisible();
});
