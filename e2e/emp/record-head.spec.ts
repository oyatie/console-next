import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { holdRead } from "../helpers/read";

// regression (INTEG round 9, fe/emp-record 493be236): the held card head rendered 소속 as plain text — no link from the
// person to their 법인 or 사업장 — and dropped the 계정 초대 entry, so chaos-people, first-run-solo, import/two-entities,
// multi-entity and accounts went red; CRUD's 퇴직 · 등록 취소 lived on the person page the card replaced. On the card
// head now: the 법인 and the 사업장 are links, an employee without an account is invited from their record, and the
// record's ends sit in the 기록 정정 row.
test("the card head links the 법인 and 사업장, invites an account and keeps 퇴직 · 등록 취소", { tag: ["@regression", "@hr"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "cardhead", "카드머리");
  await registerEmployee(admin, { name: "머리글", number: "CH-0001", unit: "채용팀" });
  const employeePath = new URL(admin.url()).pathname.replace("/people/", "/api/v1/employees/");
  const contracts = await holdRead(admin, `**${employeePath}/contracts`);
  const firstReads = Promise.all([employeePath, `${employeePath}/lifecycle-events`, "/api/v1/employment-assignments", "/api/v1/me/authz"]
    .map((path) => admin.waitForResponse((r) => new URL(r.url()).pathname === path)));
  await admin.reload();
  await contracts.requested;
  try {
    await firstReads;
    await expectAccessible(admin, "card: controls wait for the contract read");
    await expect(admin.getByRole("group", { name: "인사카드 동작" })).toBeHidden();
  } finally {
    await contracts.release();
  }

  await expect(admin.getByRole("group", { name: "인사카드 동작" })).toBeVisible();
  const exits = await holdRead(admin, /\/api\/v1\/hr\/exit-cases\?.*employee_id=/);
  await admin.reload();
  await exits.requested;
  try {
    await expectAccessible(admin, "card: controls wait for the exit-case read");
    await expect(admin.getByRole("group", { name: "인사카드 동작" })).toBeHidden();
  } finally {
    await exits.release();
  }

  const place = admin.getByRole("group", { name: "소속" });
  const links = place.getByRole("link");
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute("href", /\/org\/entities\/[^/?]+$/);
  await expect(links.nth(1)).toHaveAttribute("href", /\/org\/entities\/[^/?]+\?wp=/);
  await expect(links.nth(1)).toHaveText("본사");

  const ends = admin.getByRole("group", { name: "기록 정정" });
  await expect(ends.getByRole("button", { name: "퇴직", exact: true })).toBeVisible();
  await expect(ends.getByRole("button", { name: "등록 취소", exact: true })).toBeVisible();
  await expectAccessible(admin, "card head: places as links, 퇴직 · 등록 취소, 계정 초대");
  await ends.getByRole("button", { name: "등록 취소", exact: true }).click();
  await expect(admin.getByRole("dialog", { name: "머리글 등록 취소" })).toBeVisible();
  await admin.keyboard.press("Escape");

  await ends.getByRole("button", { name: "계정 초대" }).click();
  await expect(admin.getByRole("dialog", { name: "계정 초대" }).getByRole("combobox", { name: "초대할 직원" })).toHaveValue("머리글");
  await admin.keyboard.press("Escape");

  // The 법인 link lands on the 법인's record (no dead end from a person to where they are employed).
  await admin.goBack();
  await links.nth(0).click();
  await expect(admin).toHaveURL(/\/org\/entities\/[^/?]+$/);
});
