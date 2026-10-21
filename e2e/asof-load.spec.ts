import { expect, test } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, koDate, kstDate } from "./flows";
import { chooseWorkbook, payPeriod } from "./helpers/import";
import { many, plain, workbook } from "./helpers/import-layouts";
import { addDepts, openUnit, sheet } from "./helpers/structure";
import { openTenant } from "./helpers/tenant";
import { setupCompany, startOperations } from "./setup-flows";
import { box, findBox, leaveScreen } from "./structure-flows";

// The 2,000-person fixture enters through the normal workbook UI, with one ops account and no API writes.
test("dated chart and comparison retain 2,000 imported people through a projected rename", {
  tag: ["@org", "@first-run", "@regression"],
}, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "asof-load", "시점대량");
  await setupCompany(admin, "시점대량", "본사");
  await addDepts(admin, "본사", ["대량팀"]);
  const rows = many("AS", 2000, ["대량팀"]);
  // Each UI batch must settle before the next workbook; chart load is proved after all 2,000 rows exist.
  for (let batch = 0; batch < 10; batch += 1) {
    if (batch === 0) await go(admin, "/people/import");
    else await admin.getByRole("link", { name: "다른 명부 가져오기", exact: true }).click();
    await chooseWorkbook(admin, `시점명부_${batch + 1}.xlsx`, await workbook([plain("시점대량", rows.slice(batch * 200, (batch + 1) * 200))]));
    await payPeriod(admin);
    await admin.getByRole("button", { name: "명부 미리보기" }).click();
    await admin.getByRole("button", { name: "모의 반영 실행" }).click();
    const applied = admin.waitForResponse((r) => r.request().method() === "POST"
      && /\/api\/v1\/employees\/import\/[^/]+\/apply$/.test(new URL(r.url()).pathname));
    await admin.getByRole("button", { name: "명부 반영: 신규 200명 · 갱신 0명" }).click();
    const response = await applied;
    if (response.status() === 202) {
      expect(await response.json()).toMatchObject({ run_id: new URL(response.url()).pathname.split("/").at(-2), state: expect.stringMatching(/^(queued|applying|settling|done)$/) });
    } else {
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ inserted: 200, updated: 0 });
    }
    await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 60_000 });
    await expect(admin.getByText("신규 200명 · 갱신 0명 · 건너뜀 0명")).toBeVisible();
  }
  await startOperations(admin);
  await go(admin, "/org");
  await findBox(admin, "대량팀");
  await expect(box(admin, "대량팀")).toHaveAttribute("aria-label", /2,?000명/);
  const due = kstDate(3);
  const team = await openUnit(admin, "대량팀");
  await team.getByRole("button", { name: "이름 변경" }).click();
  const rename = sheet(admin, "대량팀 이름 변경");
  await rename.getByRole("textbox", { name: /^새 이름/ }).fill("대량미래팀");
  await rename.getByRole("textbox", { name: /^시행일/ }).fill(due);
  await rename.getByRole("textbox", { name: /^사유/ }).fill("전체 구성원을 유지하는 이름 변경");
  const submitted = admin.waitForResponse((r) => r.request().method() === "POST"
    && /^\/api\/v1\/org-changes\/[^/]+\/submit$/.test(new URL(r.url()).pathname));
  await rename.getByRole("button", { name: /^예약 · / }).click();
  expect((await submitted).status(), "scheduled rename refused").toBe(200);
  await expect(rename).toBeHidden({ timeout: 30_000 });
  const control = admin.getByRole("region", { name: "기준일", exact: true });
  await expect(control.getByRole("group", { name: "변경일" }).locator(`[data-change-date="${due}"]`)).toBeVisible();
  await control.getByRole("button", { name: "다음 변경일" }).focus();
  await admin.keyboard.press("Enter");
  await expect(control.getByLabel(/^기준일/)).toHaveValue(koDate(due));
  await findBox(admin, "대량미래팀");
  await expect(box(admin, "대량미래팀")).toHaveAttribute("aria-label", /2,?000명/);
  await expect(box(admin, "대량미래팀")).toHaveAttribute("data-scheduled", "true");
  const compare = admin.getByRole("region", { name: "기준일 비교", exact: true });
  await compare.getByRole("button", { name: "기준일 비교", exact: true }).click();
  await compare.getByLabel(/^날짜 A/).fill(kstDate());
  await compare.getByLabel(/^날짜 A/).blur();
  // Hold the dated read: its records must not steal chart height or wrap the scheduled-change link on arrival.
  const target = (url: URL) => url.pathname === "/api/v1/org-structure/diff"
    && url.searchParams.get("a") === kstDate() && url.searchParams.get("b") === due;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await admin.route(target, async (route) => { await held; await route.continue(); });
  const requested = admin.waitForRequest((request) => target(new URL(request.url())));
  const geometry = () => compare.evaluate((el) => [el.nextElementSibling!, document.getElementById("org-scheduled")!].map((node) => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { x, y, width, height };
  }));
  try {
    await compare.getByLabel(/^날짜 B/).fill(due);
    await compare.getByLabel(/^날짜 B/).blur();
    await requested;
    await expect(admin.getByRole("tree", { name: /조직도$/ })).toHaveCount(0);
    const loading = await geometry();
    release();
    await findBox(admin, "대량미래팀");
    await expect.poll(geometry).toEqual(loading);
  } finally {
    release();
    await admin.unroute(target);
  }
  await expect(box(admin, "대량미래팀")).toHaveAttribute("data-diff", /\brenamed\b/);
  await expect(box(admin, "대량미래팀")).toHaveAttribute("aria-label", /2,?000명/);
  await leaveScreen(admin);
  await expectAccessible(admin, "as-of: 2,000-person projected comparison, light and dark");
});
