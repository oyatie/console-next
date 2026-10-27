// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiAs, soloTenant } from "./chaos";
import { go } from "./flows";
import { pressRegister, receiptOf, registerSheet } from "./helpers/register";

test("undated inbox pages keep people in creation order across cursors", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const page = await soloTenant(browser, "inboxage", "업무함등록순서");
  const api = apiAs(page);
  const names = ["등록첫째", "등록둘째", "등록셋째"];
  for (const name of names) {
    await go(page, "/people/new");
    const sheet = registerSheet(page);
    await sheet.getByRole("textbox", { name: /^이름/ }).fill(name);
    await sheet.getByRole("button", { name: /^오늘/ }).click();
    await pressRegister(page);
    await expect(receiptOf(page, name)).toBeVisible();
  }
  type Inbox = { items: { id: string; kind: string; title: string }[]; next_cursor: string | null };
  let cursor: string | null = null;
  const rows: Inbox["items"] = [];
  do {
    const result: Inbox = await api<Inbox>(`/api/v1/me/action-inbox?filter=turn&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    expect(result.items).toHaveLength(1);
    expect(rows.some(row => row.id === result.items[0]!.id)).toBe(false);
    rows.push(...result.items);
    expect(rows.length).toBeLessThan(30);
    cursor = result.next_cursor;
  } while (cursor);
  expect(rows.filter(row => row.kind === "register_review").map(row => row.title)).toEqual(names);
});
