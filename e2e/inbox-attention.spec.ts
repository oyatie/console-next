// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { apiAs, soloTenant } from "./chaos";
import { go } from "./flows";
import { pressRegister, registerSheet } from "./helpers/register";

test("Home attention shares the authorized worklist and preserves item aging", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const page = await soloTenant(browser, "attention", "업무확인");
  const api = apiAs(page);
  await go(page, "/people/new");
  const sheet = registerSheet(page);
  await sheet.getByRole("textbox", { name: /^이름/ }).fill("업무확인직원");
  await sheet.getByRole("button", { name: /^오늘/ }).click();
  const registered = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/employees");
  await pressRegister(page);
  expect((await registered).status()).toBe(201);
  type Inbox = {
    items: { id: string; title: string; reason: string; age_days: number }[];
    attention_filters: { key: string; total: number; total_is_exact: boolean }[];
    next_cursor: string | null;
  };
  const all = await api<Inbox>("/api/v1/me/action-inbox?attention=all&limit=200");
  expect(all.attention_filters.map(c => c.key)).toEqual(["all", "approvals", "today", "overdue"]);
  expect(all.items.some(i => i.title === "업무확인직원")).toBe(true);
  for (const item of all.items) {
    expect(item.reason.length).toBeGreaterThan(0);
    expect(item.age_days).toBeGreaterThanOrEqual(0);
  }
  for (const filter of ["approvals", "today", "overdue"]) {
    const view = await api<Inbox>(`/api/v1/me/action-inbox?attention=${filter}&limit=200`);
    expect(view.attention_filters).toEqual(all.attention_filters);
    expect(view.items).toEqual([]);
  }
  const first = await api<Inbox>("/api/v1/me/action-inbox?attention=all&limit=1");
  expect(first.next_cursor).not.toBeNull();
  const second = await api<Inbox>(`/api/v1/me/action-inbox?attention=all&limit=1&cursor=${encodeURIComponent(first.next_cursor!)}`);
  expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  await page.context().close();
});
