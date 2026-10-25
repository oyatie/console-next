import { expect, test } from "@playwright/test";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { apiOf, bearerOf } from "./helpers/api";
import { expectDrafts, cellOf, officeSchedule, openMonth, pastWorkDay } from "./helpers/attendance-records";
import { chooseRadio, kstDate, newContext, passkeyLogin, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

const nextMonth = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7);

// Regression (P0, wrong value saved): a range over 윤하준 and 황정우 whose people changed under it (a re-read inserted
// 한지민 between them) collapsed to its focus, and that collapse committed the open editor: half of what was being
// typed became 황정우's draft, and the next key started over. The collapse leaves the editor and its text alone.
test("regression: a re-read inserting a row inside the selection while typing never commits the half-typed value", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(480_000); // a staffed tenant, two people and a schedule through the UI, a second session registering a third
  const { admin } = await staffedTenant(browser, "attcol", "근태범위주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "R-0002", hired: kstDate(-60) });
  await registerEmployee(admin, { name: "황정우", number: "R-0004", hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const idOf = async (name: string) => ((await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] }).items.find((p) => p.name === name)!.id;
  const { month, date, other } = await pastWorkDay(api, await idOf("윤하준"));
  const grid = await openMonth(admin, month);

  // Another session registers 한지민; R-0003 sorts between 윤하준 (R-0002) and 황정우 (R-0004).
  const elsewhere = await (await newContext(browser)).newPage();
  await (await virtualAuthenticator(elsewhere)).import(await authenticatorOf(admin).export());
  await elsewhere.goto("/login");
  await passkeyLogin(elsewhere);
  await registerEmployee(elsewhere, { name: "한지민", number: "R-0003", hired: kstDate(-60) });
  await elsewhere.context().close();
  await expect(cellOf(admin, "한지민", date)).toHaveCount(0);

  // A save re-reads the grid; that read is held while 윤하준–황정우 is selected and 황정우's cell is being typed.
  await cellOf(admin, "윤하준", other).click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await chooseRadio(save, /출근부 \(종이\)/);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await admin.route((url) => url.pathname === "/api/v1/attendance/month", async (route) => { await held; await route.continue(); });
  const typing = admin.getByRole("textbox", { name: new RegExp(`^황정우 ${date}`) });
  try {
    await save.getByRole("button", { name: "1칸 저장" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
    await cellOf(admin, "윤하준", date).click();
    await admin.keyboard.press("Shift+ArrowDown");
    await expect(admin.getByRole("status").filter({ hasText: /^2명 × 1일 = 2칸/ })).toBeVisible(); // the selection bar
    await admin.keyboard.type("9-1");
    await expect(typing).toHaveValue("9-1");
  } finally {
    release();
    await admin.unrouteAll({ behavior: "wait" });
  }
  await expect(cellOf(admin, "한지민", date)).toBeVisible(); // the re-read is on screen: the range has collapsed

  // The editor is still open on 황정우 with what was typed; nothing became a draft; the next key continues it.
  await expect(typing).toHaveValue("9-1");
  await expect(cellOf(admin, "황정우", date)).not.toHaveAccessibleName(/초안/);
  await expectDrafts(admin, 0);
  await admin.keyboard.type("8");
  await expect(typing).toHaveValue("9-18");
  await admin.keyboard.press("Enter");
  await expect(cellOf(admin, "황정우", date)).toHaveAccessibleName(/초안 9-18/);
  for (const name of ["윤하준", "한지민"]) await expect(cellOf(admin, name, date)).not.toHaveAccessibleName(/초안/);
  await expectDrafts(admin, 1);
});

// Regression (P0, draft lost): back-navigation while typing moved the grid to another month already read; the editor
// stayed open in the new month (its cell not shown) and the next click there committed it into that month's drafts,
// invisible there and missing on return. It is kept as a draft of the month it was typed in and shows on return.
test("regression: back-navigation while typing keeps the value as a draft of the month it was typed in", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000); // a staffed tenant, one person and a schedule through the UI
  const { admin } = await staffedTenant(browser, "attscope", "근태초안범위주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "R-0002", hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const yoon = ((await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] }).items.find((p) => p.name === "윤하준")!.id;
  const { month, date, other } = await pastWorkDay(api, yoon);
  await openMonth(admin, month);
  const later = nextMonth(month);

  // History: this month, the next (read once), this month again.
  await admin.getByRole("button", { name: "다음 달" }).click();
  await expect(cellOf(admin, "윤하준", `${later}-01`)).toBeVisible();
  await admin.getByRole("button", { name: "이전 달" }).click();
  await cellOf(admin, "윤하준", date).click();
  await admin.keyboard.type("9-18");
  await expect(admin.getByRole("textbox", { name: new RegExp(`^윤하준 ${date}`) })).toHaveValue("9-18");

  // Back: the next month, from its cached read. The value is 윤하준's draft of this month, not the next one's.
  await admin.goBack();
  await expect(cellOf(admin, "윤하준", `${later}-01`)).toBeVisible();
  await expect(admin.getByRole("status").filter({ hasText: "입력하던 값은 윤하준의 초안으로 남았습니다" })).toBeVisible();
  await expect(admin.getByRole("textbox")).toHaveCount(0);
  await cellOf(admin, "윤하준", `${later}-02`).click(); // a click here once committed the open editor into this month
  await expectDrafts(admin, 0);

  // Back again: this month, with the draft where it was typed.
  await admin.goBack();
  await expect(cellOf(admin, "윤하준", date)).toHaveAccessibleName(/초안 9-18/);
  await expectDrafts(admin, 1);

  // Forward while typing onto another tab (the month timesheet goes away altogether): still this month's draft.
  await admin.getByRole("link", { name: "일별" }).click();
  await admin.goBack();
  await cellOf(admin, "윤하준", other).click();
  await admin.keyboard.type("8-17");
  await expect(admin.getByRole("textbox", { name: new RegExp(`^윤하준 ${other}`) })).toHaveValue("8-17");
  await admin.goForward();
  await expect(admin.getByRole("link", { name: "일별" })).toHaveAttribute("aria-current", "page");
  await admin.goBack();
  await expect(cellOf(admin, "윤하준", other)).toHaveAccessibleName(/초안 8-17/);
  await expect(cellOf(admin, "윤하준", date)).toHaveAccessibleName(/초안 9-18/);
  await expectDrafts(admin, 2);
});
