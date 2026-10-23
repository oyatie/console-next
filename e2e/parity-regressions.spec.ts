import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { apiAs, sent, soloTenant } from "./chaos";
import { go, kstDate } from "./flows";
import { openRegistered, pressRegister, receiptOf, registerSheet } from "./helpers/register";

for (const explicit of [false, true]) {
  test(`name and hire date register ${explicit ? "explicitly" : "implicitly"} unplaced with statutory follow-ups`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
    const page = await soloTenant(browser, `minimum-${explicit}`, "최소등록");
    const api = apiAs(page);
    await go(page, "/people/new");
    const sheet = registerSheet(page);
    const creates = sent(page, /\/api\/v1\/employees$/);
    await pressRegister(page);
    await expect(sheet.getByRole("alert")).toContainText("이름");
    expect(creates.count()).toBe(0);
    await sheet.getByRole("textbox", { name: /^이름/ }).fill("최최소");
    await pressRegister(page);
    await expect(sheet.getByRole("alert")).toContainText("입사일");
    expect(creates.count()).toBe(0);
    await sheet.getByRole("button", { name: /^오늘/ }).click();
    if (explicit) await sheet.getByRole("radiogroup", { name: /^어디에 둡니까/ }).getByText("미배치로 둠", { exact: true }).click();
    await sheet.getByRole("textbox", { name: /^휴대전화/ }).fill("010-12");
    await pressRegister(page);
    await expect(sheet.getByRole("alert")).toContainText("휴대전화");
    expect(creates.count()).toBe(0);
    await sheet.getByRole("textbox", { name: /^휴대전화/ }).fill("");
    await expectAccessible(page, "minimum registration");
    const registered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/employees");
    await pressRegister(page);
    const response = await registered;
    expect(response.status()).toBe(201);
    const detail = await response.json();
    expect(detail.employee.hire_date).toBe(kstDate());
    expect(detail.employee.org_unit_id).toBeNull();
    expect(detail.employee.workplace_id).toBeNull();
    expect(detail.employee.register_review_required).toBe(true);
    expect(detail.employment).toBeNull();
    expect(detail.pending_employment.employment_type).toBeNull();
    expect(detail.pending_employment.phone_e164 ?? null).toBeNull();
    expect(detail.pending_employment.base_pay ?? null).toBeNull();
    await expect(receiptOf(page, "최최소")).toBeVisible();
    await openRegistered(page, "최최소");
    await expect(page.getByRole("heading", { name: "최최소", exact: true })).toBeVisible();
    await expect(page.getByText("확인 필요", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("5개 빠짐", { exact: true })).toBeVisible();
    const inbox = await api<{ items: unknown[] }>("/api/v1/me/action-inbox");
    expect(inbox.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "hr_request", id: expect.stringMatching(/^hr_register:/), title: "최최소" })]));
    const reviewRead = page.waitForResponse((r) => {
      const url = new URL(r.url());
      return r.request().method() === "GET" && url.pathname === "/api/v1/employees" && url.searchParams.get("register_review_required") === "true";
    });
    await go(page, "/");
    const reviewResponse = await reviewRead;
    expect(reviewResponse.status(), "Home's register-review read failed").toBe(200);
    const reviewPage = await reviewResponse.json() as { items: { id: string }[] };
    expect(reviewPage.items.map(({ id }) => id)).toContain(detail.employee.id);
    await expect(page.getByRole("main").getByText("불러오는 중…", { exact: true })).toBeHidden({ timeout: 15_000 });
    const review = page.getByRole("region", { name: "확인할 직원 기록" });
    await expect(review.getByRole("link", { name: "최최소", exact: true })).toBeVisible();
    await expect(review.getByText("확인 필요", { exact: true })).toBeVisible();
    await review.getByRole("link", { name: /명부 항목 빠짐/ }).click();
    await expect(page.getByRole("grid", { name: "직원", exact: true }).getByText("최최소", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "미배치", exact: true }).click();
    await expect(page.getByText("최최소", { exact: true }).first()).toBeVisible();
    if (!explicit) {
      for (const name of ["최다음", "최마지막"]) {
        await go(page, "/people/new");
        const nextSheet = registerSheet(page);
        await nextSheet.getByRole("textbox", { name: /^이름/ }).fill(name);
        await nextSheet.getByRole("button", { name: /^오늘/ }).click();
        await pressRegister(page);
        await expect(receiptOf(page, name)).toBeVisible();
      }
      type Inbox = { items: { id: string; title: string }[]; total: number; next_cursor: string | null };
      const first = await api<Inbox>("/api/v1/me/action-inbox?limit=1");
      expect(first.items.map((item) => item.title)).toEqual(["최최소"]);
      expect(first.total).toBe(15);
      expect(first.next_cursor).not.toBeNull();
      const items = [...first.items];
      let cursor = first.next_cursor;
      let secondRegisterCursor: string | null = null;
      for (let index = 1; index < first.total; index++) {
        expect(cursor).not.toBeNull();
        const next = await api<Inbox>(`/api/v1/me/action-inbox?limit=1&cursor=${encodeURIComponent(cursor!)}`);
        expect(next.items).toHaveLength(1);
        expect(next.total).toBe(first.total);
        items.push(...next.items);
        cursor = next.next_cursor;
        if (next.items.some(({ id, title }) => id.startsWith("hr_register:") && title === "최다음")) secondRegisterCursor = cursor;
      }
      expect(cursor).toBeNull();
      expect(new Set(items.map((item) => item.id)).size).toBe(first.total);
      expect(items.filter((item) => item.id.startsWith("hr_register:")).map((item) => item.title)).toEqual(["최최소", "최다음", "최마지막"]);
      for (const name of ["최최소", "최다음", "최마지막"])
        expect(items.filter((item) => item.title === name && item.id.startsWith("insurance_filing_ACQUIRE_"))).toHaveLength(4);
      expect(secondRegisterCursor).not.toBeNull();
      const otherSourceCursor = secondRegisterCursor!.replace("hr_register:", "support:");
      const third = await api<Inbox>(`/api/v1/me/action-inbox?limit=1&cursor=${encodeURIComponent(otherSourceCursor)}`);
      expect(third.items.map((item) => item.title)).toEqual(["최마지막"]);
      expect(third.total).toBe(first.total);
      expect(third.next_cursor).not.toBeNull();
    }
  });
}

test("zero-facet roster shows a failed read and retry before the first-use empty state", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const page = await soloTenant(browser, "roster-failed", "목록실패");
  // Exhaust the longest retry jitter, which can outlast an assertion's default deadline.
  await page.evaluate(() => { Math.random = () => 1 - Number.EPSILON; });
  let fail = true;
  let requests = 0;
  await page.route("**/api/v1/employees?*", async (route) => {
    requests++;
    if (fail) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "internal_error", message: "failed" }) });
    else await route.continue();
  });
  await go(page, "/people");
  await page.getByText("목록을 받지 못했습니다", { exact: true }).waitFor({ state: "visible" });
  await expect(page.getByText("목록을 받지 못했습니다", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "아직 직원이 없습니다" })).toBeHidden();
  fail = false;
  const before = requests;
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("heading", { name: "아직 직원이 없습니다" })).toBeVisible();
  expect(requests).toBeGreaterThan(before);
  await expect(page.getByText("목록을 받지 못했습니다", { exact: true })).toBeHidden();
});

test("zero-facet roster waits for its delayed list before claiming first-use empty", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const page = await soloTenant(browser, "roster-delayed", "목록대기");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/employees?*", async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await go(page, "/people");
  await expect(page.getByRole("grid", { name: "직원", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "아직 직원이 없습니다" })).toBeHidden();
  release();
  await expect(page.getByRole("heading", { name: "아직 직원이 없습니다" })).toBeVisible();
});
