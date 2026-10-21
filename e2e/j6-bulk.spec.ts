import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { clickCounter } from "./clicks";
import { go, koDate, kstDate, registerEmployee } from "./flows";
import { openHistory } from "./record";
import { staffedTenant } from "./setup-flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";

type Clicks = ReturnType<typeof clickCounter>;
const today = koDate(kstDate());

/** Type, date, reason code and reason: nothing is preselected, so each is one click (typing is free); no statement to tick (BW-11 A13). */
async function fillCommon(sheet: Locator, admin: Page, c: Clicks) {
  await c.click(sheet.getByRole("radiogroup", { name: /발령 종류/ }).getByText("전보", { exact: true }));
  return async () => {
    await c.click(sheet.getByRole("button", { name: /오늘 · 바로 반영/ }));
    await c.click(sheet.getByRole("radiogroup", { name: /^사유 분류/ }).getByText("조직 개편", { exact: true }));
    await sheet.getByRole("textbox", { name: /^사유/ }).fill("조직 개편");
    await expect(admin.getByRole("button", { name: /오늘 전보$/ })).toHaveClass(/btn--danger/); // applies now: red
  };
}

// J6 일괄 발령: pick people on the roster and transfer them in one all-or-nothing batch.
test("J6 bulk transfer: a refused person is named and nothing is recorded; retrying without them moves the rest", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  const { admin } = await staffedTenant(browser, "j6co", "일괄주식회사");
  const api = apiOf(admin, bearerOf(admin));
  const c = clickCounter();
  const names = ["김일번", "이이번", "박삼번"];
  for (const [i, name] of names.entries()) await registerEmployee(admin, { name, number: `J6-000${i + 1}`, unit: i === 2 ? "채용팀" : "인사부" });

  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("");
  await find.press("Enter");
  // The drawn box (its label) takes the click, as a user's would: the checkbox input itself is visually hidden.
  for (const name of names) await c.click(admin.getByRole("row", { name: new RegExp(name) }).locator("label", { has: admin.getByRole("checkbox") }));
  await expect(admin.getByRole("status").filter({ hasText: "3명 선택됨" })).toBeVisible();
  await expectAccessible(admin, "J6: roster with a selection");
  await c.click(admin.getByRole("button", { name: "선택한 3명 일괄 발령" }));
  // The bulk workspace (spec E6-move): who, before anything is chosen; no kind, no date.
  await expect(admin.getByRole("heading", { name: "일괄 발령 · 3명", level: 1 })).toBeVisible();
  for (const name of names) await expect(admin.getByRole("table", { name: /지금 → 새 위치/ })).toContainText(name);
  await c.click(admin.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "전보" }));
  await c.click(admin.getByRole("listbox", { name: "어디로" }).getByRole("option", { name: /^채용팀/ }));
  // 박삼번 is already in 채용팀: shown before the server refuses it.
  await expect(admin.getByRole("row", { name: /박삼번/ })).toContainText("이미 이 조직 소속입니다");
  // @regression: a long check pushed the row's 빼기 out of the people pane (it scrolled sideways); the check wraps now.
  const sideways = await admin.getByRole("table", { name: /지금 → 새 위치/ }).evaluate((t) => t.parentElement!.scrollWidth - t.parentElement!.clientWidth);
  expect(sideways).toBeLessThanOrEqual(1);
  await c.click(admin.getByRole("button", { name: /^오늘 \d{2}-\d{2}/ }));
  await c.click(admin.getByRole("radiogroup", { name: /^사유/ }).getByText("조직 개편", { exact: true }));
  await admin.getByRole("textbox", { name: /^메모/ }).fill("조직 개편");
  await expectAccessible(admin, "J6: bulk workspace ready");
  await c.click(admin.getByRole("button", { name: /^3명 전보 · 오늘 반영/ }));
  await expect(admin.getByRole("alert").filter({ hasText: "1명이 거부되어 이 발령은 기록되지 않았습니다" })).toBeVisible();
  await expect(admin.getByRole("row", { name: /박삼번/ })).toContainText("거부됨");
  await expectAccessible(admin, "J6: refused batch");

  // The rescind reasons are read once the batch exists; held back here so they land after the sheet opens (the race a
  // loaded machine hits), for the regression below.
  await admin.route(/\/api\/v1\/reason-codes\?.*lifecycle_cancel/, async (r) => (await new Promise((ok) => setTimeout(ok, 2_000)), r.continue()));
  await c.click(admin.getByRole("button", { name: "거부된 1명 제외 후 다시 시도" }));
  await expect(admin.getByRole("status").filter({ hasText: "2명 전보 반영함" })).toBeVisible();
  // Base 3 picks + open + kind + unit + date + reason code + commit + retry.
  expect(c.done("J6 bulk transfer of 3 (one refused, retried without)")).toBeLessThanOrEqual(10);

  // BW-11: the whole batch is rescinded as one from the workspace's receipt; both go back to 인사부.
  await admin.getByRole("button", { name: "이 일괄 발령 철회 (2명)" }).click();
  const rescind = admin.getByRole("dialog", { name: "일괄 발령 철회" });
  // Regression (EMP-B, @regression): when the reason list landed after the sheet opened, it grew from nothing to a row of
  // chips and pushed 「철회 메모」 down 32 px under the user's hand. The field keeps its place.
  const memo = rescind.getByRole("textbox", { name: /^철회 메모/ });
  await expect(memo).toBeVisible();
  const y0 = (await memo.boundingBox())!.y;
  await expect(rescind.getByRole("radiogroup", { name: /^철회 사유/ }).getByText("계획 철회", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect((await memo.boundingBox())!.y, "the memo field stays where it was when the reasons landed").toBe(y0);
  await rescind.getByRole("radiogroup", { name: /^철회 사유/ }).getByText("계획 철회", { exact: true }).click();
  await expectAccessible(admin, "J6: rescind a bulk appointment");
  // Someone undoes the batch first (another HR person, here the API): this screen's own undo is then refused as gone
  // (404), said in words, and nothing more is changed; a second undo at the API is refused the same way.
  const batchOf = async () => {
    let id = "";
    await expect(async () => {
      const people = ((await (await api(`/employees?search=${encodeURIComponent("이이번")}&limit=1`)).json()) as { items: { id: string }[] }).items;
      const evs = ((await (await api(`/employees/${people[0]!.id}/lifecycle-events`)).json()) as { items: { batch_id?: string; event_type: string }[] }).items;
      id = evs.find((x) => x.event_type === "TRANSFER" && x.batch_id)!.batch_id!;
    }).toPass({ timeout: 15_000 });
    return id;
  };
  const batch = await batchOf();
  const body = { reason_code: "PLAN_WITHDRAWN", note: "다른 담당자가 먼저 철회", confirm_cascades: true };
  expect((await api(`/employees/lifecycle-events/bulk/${batch}/rescind`, "POST", body)).status()).toBe(200);
  await rescind.getByRole("button", { name: "2명 모두 철회" }).click();
  await expect(rescind.getByRole("alert")).toContainText("이미 철회되었거나 되돌릴 기록이 남아 있지 않습니다");
  // At the API a second undo of an applied batch is refused person by person as already voided (contract-be.md says
  // 404; the server answers 422 — backend-followups EMP-B2), and nothing more is written.
  const again = await api(`/employees/lifecycle-events/bulk/${batch}/rescind`, "POST", body);
  expect([again.status(), await codeOf(again)]).toEqual([422, "bulk_lifecycle_refused"]);
  expect(await again.text()).toContain("lifecycle_event_voided");
  await rescind.getByRole("button", { name: "닫기", exact: true }).click();
  await go(admin, "/people");
  for (const name of names.slice(0, 2)) await expect(admin.getByRole("row", { name: new RegExp(name) })).toContainText("인사부");

  // Each person's history records the transfer and its rescission.
  await admin.getByRole("rowheader", { name: "이이번", exact: true }).click();
  await admin.getByRole("complementary", { name: "직원 상세" }).getByRole("link", { name: "인사카드 열기" }).click();
  await openHistory(admin);
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: /이이번을 인사부에서 채용팀으로 전보했습니다/ })).toContainText("철회됨");
});

test("J6 bulk transfer from a paste: lines keyed by employee number, errors first, one batch across units", { tag: "@hr" }, async ({ browser }) => {
  test.setTimeout(300_000); // five people registered through the UI before the journey starts
  const { admin } = await staffedTenant(browser, "j6pa", "붙여넣기주식회사");
  const c = clickCounter();
  const people = [["김일번", "인사부"], ["이이번", "인사부"], ["박삼번", "인사부"], ["정사번", "채용팀"], ["최오번", "인사부"]] as const;
  for (const [i, [name, unit]] of people.entries()) await registerEmployee(admin, { name, unit, number: `P6-000${i + 1}` });

  await go(admin, "/people");
  await c.click(admin.getByRole("link", { name: "붙여넣어 일괄 발령" }));
  const sheet = admin.getByRole("dialog", { name: "일괄 발령" });
  const paste = ["사번\t새 조직\t이름", "P6-0001\t채용팀\t김일번", "P6-0002\t채용팀", "P6-0003\t인사부\t박삼번", "P6-0004\t인사부\t정사번", "P6-9999\t채용팀", "P6-0005\t채용팀\t최오오", "P6-0001\t채용팀\t김일번"];
  await sheet.getByLabel(/사번 목록/).fill(paste.join("\n"));

  // Back closes the sheet; the paste is still there when it opens again.
  await admin.goBack();
  await expect(sheet).toBeHidden();
  await admin.getByRole("link", { name: "붙여넣어 일괄 발령" }).click();
  await expect(sheet).toContainText("작성하던 내용을 불러왔습니다");
  await expect(sheet.getByLabel(/사번 목록/)).toHaveValue(paste.join("\n"));

  const issues = sheet.getByRole("list", { name: "확인할 줄" });
  await expect(issues).toContainText("6줄 · P6-9999 · 사번을 찾을 수 없습니다");
  await expect(issues).toContainText("7줄 · P6-0005 · 최오번 · 붙여 넣은 이름과 다릅니다 (등록된 이름: 최오번)");
  const grid = sheet.getByRole("grid", { name: "발령 대상" });
  await expect(grid).toContainText("중복 사번 · 2, 8줄을 한 줄로 합쳤습니다");
  await expectAccessible(admin, "J6: checked paste");

  const rest = await fillCommon(sheet, admin, c);
  await expect(sheet).toContainText("붙여 넣은 조직으로 전보합니다");
  // The new unit reads by its own name, whole at the sheet's width; its full path is the title.
  const leaf = grid.locator('[title$=" › 채용팀"]').first();
  await expect(leaf).toHaveText("채용팀");
  expect(await leaf.evaluate((el) => el.parentElement!.scrollWidth <= el.parentElement!.clientWidth)).toBe(true);
  await expect(issues).toContainText("4줄 · P6-0003 · 박삼번 · 이미 이 조직 소속입니다");
  await rest();
  await expect(sheet).toContainText("새 조직이 2곳이어도 한 번의 발령으로 기록합니다");
  // Lines that can't be read stop the commit and take focus to the first one to fix.
  await sheet.getByRole("button", { name: "4명 오늘 전보" }).click();
  await expect(sheet).toContainText("오류 2줄을 수정하거나 제외해야 기록할 수 있습니다");
  await expect(sheet.getByRole("button", { name: "6줄 · P6-9999 제외" })).toBeFocused();
  await sheet.getByRole("button", { name: "6줄 · P6-9999 제외" }).click();
  await sheet.getByRole("button", { name: "7줄 · P6-0005 제외" }).click();
  await c.click(sheet.getByRole("button", { name: "4명 오늘 전보" }));
  // Paste mode: open + type + date + reason code + commit, plus the 2 required statements; the unit comes from the paste.
  expect(c.done("J6 bulk transfer from a paste")).toBeLessThanOrEqual(5);

  // One change set (BW-38): 박삼번's refusal refuses every line, and the set is resent without him under a new key.
  await expect(sheet.getByRole("alert").filter({ hasText: "1명이 거부되어 이 발령은 기록되지 않았습니다" })).toBeVisible();
  await expect(issues).toContainText("거부됨 4줄 · P6-0003 · 박삼번 · 이미 그 조직·직위입니다");
  await sheet.getByRole("button", { name: "거부된 1명 제외 후 다시 시도" }).click();
  await expect(sheet).toBeHidden();
  await expect(admin.getByRole("status").filter({ hasText: `3명을 ${today}자로 전보했습니다` })).toBeVisible();
  for (const [name, unit] of [["김일번", "채용팀"], ["이이번", "채용팀"], ["정사번", "인사부"], ["박삼번", "인사부"], ["최오번", "인사부"]] as const)
    await expect(admin.getByRole("row", { name: new RegExp(name) })).toContainText(unit);

  // Recorded: reopening starts empty.
  await admin.getByRole("link", { name: "붙여넣어 일괄 발령" }).click();
  await expect(sheet.getByLabel(/사번 목록/)).toHaveValue("");
});
