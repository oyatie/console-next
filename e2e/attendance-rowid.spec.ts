import { expect, test } from "@playwright/test";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { apiOf, bearerOf } from "./helpers/api";
import { cellOf, officeSchedule, openMonth, pastWorkDay } from "./helpers/attendance-records";
import { chooseRadio, kstDate, newContext, passkeyLogin, registerEmployee } from "./flows";
import { staffedTenant } from "./setup-flows";

type Month = { history: { date: string; entry: { segments: { start: number; end: number }[] } }[] };

// Regression (P0, wrong-person entry): the month timesheet kept the focused cell and the open editor by row index.
// A re-read that brought in a person registered elsewhere (sorting above) while 윤하준's cell was being typed moved the
// editor to the newcomer's row, and Enter then 저장 wrote 윤하준's hours to someone else. They land on 윤하준 only.
test("regression: a re-read inserting a row above the cell being typed never moves the value to another person", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(480_000); // a staffed tenant, two people and a schedule through the UI, a second session registering a third
  const { admin } = await staffedTenant(browser, "attrow", "근태행고정주식회사");
  const bearer = bearerOf(admin);
  await registerEmployee(admin, { name: "윤하준", number: "R-0002", hired: kstDate(-60) });
  await registerEmployee(admin, { name: "황정우", number: "R-0003", hired: kstDate(-60) });
  await officeSchedule(admin);
  const api = apiOf(admin, bearer);
  const idOf = async (name: string) => ((await (await api("/employees?limit=10")).json()) as { items: { id: string; name: string }[] }).items.find((p) => p.name === name)!.id;
  const yoon = await idOf("윤하준");
  const { month, date, other } = await pastWorkDay(api, yoon);
  const history = async (id: string) => ((await (await api(`/attendance/people/${id}/month?month=${month}`)).json()) as Month).history;
  const grid = await openMonth(admin, month);

  // Another session (the same account in another browser) registers 한지민; R-0001 sorts above 윤하준's R-0002.
  const elsewhere = await (await newContext(browser)).newPage();
  await (await virtualAuthenticator(elsewhere)).import(await authenticatorOf(admin).export());
  await elsewhere.goto("/login");
  await passkeyLogin(elsewhere);
  await registerEmployee(elsewhere, { name: "한지민", number: "R-0001", hired: kstDate(-60) });
  await elsewhere.context().close();
  await expect(cellOf(admin, "한지민", date)).toHaveCount(0); // not on this grid yet

  // A save re-reads the grid; that read is slow (a large month), and 윤하준's next cell is typed while it is on its way.
  await cellOf(admin, "윤하준", other).click();
  await admin.keyboard.type("9-18");
  await admin.keyboard.press("Enter");
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  const save = admin.getByRole("complementary", { name: /저장 · 초안 1칸/ });
  await chooseRadio(save, /출근부 \(종이\)/);
  const monthRead = (url: URL) => url.pathname === "/api/v1/attendance/month";
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await admin.route(monthRead, async (route) => { await held; await route.continue(); });
  try {
    await save.getByRole("button", { name: "1칸 저장" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "1칸을 저장했습니다" })).toBeVisible();
    await cellOf(admin, "윤하준", date).click();
    await admin.keyboard.type("9-18");
    await expect(admin.getByRole("textbox", { name: new RegExp(`^윤하준 ${date}`) })).toHaveValue("9-18");
  } finally {
    release();
    await admin.unrouteAll({ behavior: "wait" });
  }
  await expect(cellOf(admin, "한지민", date)).toBeVisible();

  // The input is still 윤하준's: no other row holds an editor, and Enter (or the blur of the move) drafts it on him.
  for (const name of ["한지민", "황정우"]) await expect(admin.getByRole("textbox", { name: new RegExp(`^${name} `) })).toHaveCount(0);
  await admin.keyboard.press("Enter");
  await expect(cellOf(admin, "윤하준", date)).toHaveAccessibleName(/초안 9-18/);
  for (const name of ["한지민", "황정우"]) await expect(cellOf(admin, name, date)).not.toHaveAccessibleName(/초안/);

  // Save: exactly one cell, and it is 윤하준's.
  await grid.focus();
  await admin.keyboard.press("ControlOrMeta+s");
  await chooseRadio(save, /출근부 \(종이\)/);
  await save.getByRole("button", { name: "1칸 저장" }).click();
  await expect(save).toBeHidden(); // closed on success (the first save's receipt is still on screen)
  await expect(admin.getByRole("status").filter({ hasText: /^저장 안 된 칸 0 / })).toBeVisible();

  const mine = await history(yoon);
  expect(mine.map((h) => h.date).sort()).toEqual([other, date].sort());
  const typed = mine.find((h) => h.date === date)!.entry.segments;
  expect([typed[0]!.start, typed.at(-1)!.end]).toEqual([9 * 60, 18 * 60]);
  expect(await history(await idOf("한지민"))).toEqual([]);
  expect(await history(await idOf("황정우"))).toEqual([]);
});
