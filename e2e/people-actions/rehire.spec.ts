import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, kstDate, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { fillDate, signOff } from "../sheet";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { forgetResize } from "../stability";

// 재입사 (spec E3-rehire) through the UI: refused for someone still employed (the record says why; the server answers
// 409 rehire_requires_exited and writes nothing), then, after the exit is confirmed, the same 사번 starts a new period
// from the 어디에 둡니까 chips, with every gap named first.

test("rehire: refused while employed at both levels; after the exit, a new period under the same 사번", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await staffedTenant(browser, "rehco", "재입사주식회사");
  const api = apiOf(admin, bearerOf(admin));
  await registerEmployee(admin, { name: "김돌아", number: "RH-0001", hired: kstDate(-500) });
  const path = new URL(admin.url()).pathname;
  const id = path.split("/").pop()!;
  const revision = async () => ((await (await api(`/employees/${id}`)).json()) as { employee: { updated_at: string; status: string } }).employee;

  // Still employed: the record says why instead of a form; the API refuses and the record is untouched.
  await go(admin, `${path}?act=rehire`);
  await expect(admin.getByRole("status").filter({ hasText: "퇴직한 사람만 재입사로 등록합니다" })).toBeVisible();
  const before = await revision();
  const unit = ((await (await api("/org-units")).json()) as { items: { id: string; name: string }[] }).items.find((u) => u.name === "채용팀")!.id;
  const early = await api(`/employees/${id}/rehire`, "POST", { hire_date: kstDate(1), employment_type: "REGULAR", org_unit_id: unit, position: "사원", idempotency_key: crypto.randomUUID() });
  expect([early.status(), await codeOf(early)]).toEqual([409, "rehire_requires_exited"]);
  expect(await revision()).toEqual(before);

  // The exit: reported with today as the last working day, then confirmed by HR.
  await go(admin, path);
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const report = admin.getByRole("dialog", { name: /퇴직 보고/ });
  await fillDate(report, kstDate(-1), "마지막 근무일");
  await report.getByRole("textbox", { name: /^퇴직 경위/ }).fill("개인 사정");
  await report.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await report.getByRole("button", { name: /퇴직 보고$/ }).click();
  await admin.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
  await signOff(admin.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
  await admin.getByRole("dialog").getByRole("button", { name: /퇴직 1명 (반영|예약)/ }).click();
  await expect(admin.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => (await revision()).status).toBe("EXITED");

  // The rehire sheet: nothing chosen; a commit names every gap and writes nothing.
  await go(admin, `${path}?act=rehire`);
  const sheet = admin.getByRole("dialog", { name: "재입사로 등록" });
  await expect(sheet.getByRole("radiogroup", { name: /^어디에 둡니까/ }).getByRole("radio", { checked: true })).toHaveCount(0);
  // The record behind the sheet shifts once as its reads land; this check is about the sheet, so it starts after them.
  await expect(admin.getByText("불러오는 중")).toHaveCount(0);
  await forgetResize(admin);
  await sheet.getByRole("button", { name: /재입사 1명 (예약|반영)/ }).click();
  await expect(sheet).toContainText(/채울 것 \d+개/);
  expect((await revision()).status).toBe("EXITED");
  await expectAccessible(admin, "E3-rehire: gaps named");

  await sheet.getByRole("radiogroup", { name: /^어디에 둡니까/ }).getByText("부서에 둠", { exact: true }).click();
  await sheet.getByRole("combobox", { name: "둘 곳" }).pressSequentially("채용");
  await admin.getByRole("option", { name: /채용팀/ }).first().click();
  await fillDate(sheet, kstDate(0), "입사일");
  await sheet.getByRole("radiogroup", { name: /^고용형태/ }).getByText("정규직", { exact: true }).click();
  await sheet.getByRole("button", { name: /재입사 1명 (예약|반영)/ }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  const after = await revision();
  expect(after.status).toBe("ACTIVE");
  // Once employed again, a second rehire is refused the same way.
  const twice = await api(`/employees/${id}/rehire`, "POST", { hire_date: kstDate(2), employment_type: "REGULAR", org_unit_id: unit, position: "사원", idempotency_key: crypto.randomUUID() });
  expect([twice.status(), await codeOf(twice)]).toEqual([409, "rehire_requires_exited"]);
});
