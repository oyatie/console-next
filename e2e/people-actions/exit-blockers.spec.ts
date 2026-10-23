import { expect, test, type Locator } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { clickCounter } from "../clicks";
import { koDate, kstDate, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { fillDate, reasonBox, sheet } from "../sheet";
import { reasonChip } from "../helpers/lifecycle";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { hrAct } from "../record";

// 퇴직 보고, blockers first (spec E5-exit): a reservation dated after the last working day is named above the date
// with its own 「예약 취소」; the withdrawal comes back to the report, which then has nothing to settle. A second report
// while the case is open is refused by the server (409 exit_case_open) and writes no second case.

/** Picks a 퇴직 사유 chip by its words (the whole list is drawn as chips, spec E5-exit). */
async function pickReason(report: Locator, name: string) {
  await report.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText(name, { exact: true }).click();
}

test("exit report: a later reservation is named first and withdrawn in place; a second report is refused", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await staffedTenant(browser, "exblk", "퇴직예약주식회사");
  const api = apiOf(admin, bearerOf(admin));
  const c = clickCounter();
  await registerEmployee(admin, { name: "정예약", number: "EX-0001", hired: kstDate(-400) });
  const id = new URL(admin.url()).pathname.split("/").pop()!;
  const cases = async () => ((await (await api(`/hr/exit-cases?employee_id=${id}`)).json()) as { items: unknown[] }).items.length;
  const history = admin.getByRole("region", { name: "인사 이력" });

  // A transfer reserved 40 days on.
  const move = kstDate(40);
  await hrAct(admin, "전보");
  const transfer = sheet(admin, "정예약 전보");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("채용");
  await admin.getByRole("option", { name: /채용팀/ }).click();
  await fillDate(transfer, move);
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("채용팀 합류");
  await transfer.getByRole("button", { name: `전보 예약 · ${koDate(move)} 시행`, exact: true }).click();
  await expect(history.getByText(/정예약을 채용팀으로 전보하도록 예약했습니다/)).toBeVisible();

  // The report: the reservation after the last working day is named first, with its own withdrawal.
  // The card's 퇴직 (CRUD's row under the name), wherever the history left the tab.
  await c.click(admin.getByRole("group", { name: "기록 정정" }).getByRole("button", { name: "퇴직", exact: true }));
  const report = admin.getByRole("dialog", { name: /퇴직 보고/ });
  await fillDate(report, kstDate(10), "마지막 근무일");
  const first = report.getByRole("status").filter({ hasText: "먼저 정리할 것 1건" });
  await expect(first).toContainText(`${koDate(move)} 전보 예약이 남아 있습니다`);
  await expectAccessible(admin, "E5-exit: a reservation to settle first");
  await c.click(first.getByRole("button", { name: "예약 취소" }));
  const cancel = sheet(admin, "전보 예약 취소");
  await cancel.getByRole("textbox", { name: /^취소 사유/ }).fill("퇴직이 먼저 정해짐");
  await c.click(cancel.getByRole("button", { name: "전보 1명 취소" }));
  await c.click(history.getByRole("button", { name: "퇴직 보고 작성으로 돌아가기" }));
  await fillDate(report, kstDate(10), "마지막 근무일");
  await expect(report.getByText("먼저 정리할 것")).toHaveCount(0);
  await report.getByRole("textbox", { name: /^퇴직 경위/ }).fill("개인 사정");
  // 퇴직 사유 from the one list (BE-EMP-UI). A code the server no longer takes (a tenant code retired while the sheet was
  // open; simulated by sending a retired code in the picked one's place) is refused in place: the sheet stays, the
  // words say why, and nothing is reported.
  await pickReason(report, "개인 사정");
  await admin.route("**/api/v1/hr/exit-cases", (r) =>
    r.request().method() === "POST" ? r.continue({ postData: JSON.stringify({ ...r.request().postDataJSON(), exit_reason_code: "T_RETIRED" }) }) : r.continue(),
  );
  await report.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
  await expect(report.getByRole("alert")).toContainText("이 퇴직 사유는 더는 쓰지 않습니다");
  await expect(report).toBeVisible();
  expect(await cases()).toBe(0);
  await admin.unroute("**/api/v1/hr/exit-cases");
  await c.click(report.getByRole("button", { name: "퇴직 보고 1명 반영" }));
  await expect(report).toBeHidden({ timeout: 15_000 });
  expect(c.done("E5-exit with a reservation withdrawn in place")).toBeLessThanOrEqual(9);

  // The case carries its 퇴직 사유; the server refuses a second report while it is open, and nothing is written.
  const [only] = ((await (await api(`/hr/exit-cases?employee_id=${id}`)).json()) as { items: { exit_reason_code?: string }[] }).items;
  expect(only?.exit_reason_code).toBe("PERSONAL");
  expect(await cases()).toBe(1);
  const invalid = await api("/hr/exit-cases", "POST", { employee_id: id, effective_exit_date: kstDate(20), site_manager_note: "x", exit_reason_code: "NO_SUCH" }, { "Idempotency-Key": crypto.randomUUID() });
  expect([invalid.status(), await codeOf(invalid)]).toEqual([422, "reason_code_invalid"]);
  const again = await api("/hr/exit-cases", "POST", { employee_id: id, effective_exit_date: kstDate(20), site_manager_note: "두 번째 보고" }, { "Idempotency-Key": crypto.randomUUID() });
  expect([again.status(), await codeOf(again)]).toEqual([409, "exit_case_open"]);
  expect(await cases()).toBe(1);
});
