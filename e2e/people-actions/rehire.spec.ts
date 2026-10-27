// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, kstDate, registerEmployee, routeReady } from "../flows";
import { staffedTenant } from "../setup-flows";
import { fillDate, signOff, statement } from "../sheet";
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
  await admin.goto(new URL(`${path}?act=rehire`, admin.url()).href);
  await routeReady(admin, `${path}?act=rehire`);
  await expect(admin.getByRole("status").filter({ hasText: "퇴직한 사람만 재입사로 등록합니다" })).toBeVisible();
  const before = await revision();
  const unit = ((await (await api("/org-units")).json()) as { items: { id: string; name: string }[] }).items.find((u) => u.name === "채용팀")!.id;
  const early = await api(`/employees/${id}/rehire`, "POST", { hire_date: kstDate(1), employment_type: "REGULAR", org_unit_id: unit, position: "사원", idempotency_key: crypto.randomUUID() });
  expect([early.status(), await codeOf(early)]).toEqual([409, "rehire_requires_exited"]);
  expect(await revision()).toEqual(before);

  // The exit: reported with yesterday as the last working day, then confirmed by HR.
  await admin.getByRole("status").filter({ hasText: "퇴직한 사람만 재입사로 등록합니다" }).getByRole("button", { name: "알림 닫기", exact: true }).click();
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const report = admin.getByRole("dialog", { name: /퇴직 보고/ });
  await fillDate(report, kstDate(-1), "마지막 근무일");
  await report.getByRole("textbox", { name: /^퇴직 경위/ }).fill("개인 사정");
  await report.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await report.getByRole("button", { name: "퇴직 보고 1명 적용" }).click();
  await admin.getByRole("button", { name: "인사 확인하고 퇴직 처리" }).click();
  await signOff(admin.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
  await admin.getByRole("dialog").getByRole("button", { name: /퇴직 1명 (적용|예약)/ }).click();
  await expect(admin.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
  await expect.poll(async () => (await revision()).status).toBe("EXITED");

  // HR confirmation closes the employment period; the prior decision still needs HQ confirmation.
  await admin.getByRole("button", { name: "재입사로 등록", exact: true }).click();
  await expect(admin.getByRole("status").filter({ hasText: "이전 퇴직 결정이 끝나지 않았습니다. 본사 확인을 마친 뒤 남은 절차를 확인하십시오." })).toBeVisible();
  await expect(admin.getByRole("dialog", { name: "재입사로 등록" })).toHaveCount(0);
  const exited = await revision();
  const pending = await api(`/employees/${id}/rehire`, "POST", { hire_date: kstDate(0), employment_type: "REGULAR", org_unit_id: unit, position: "사원", acknowledge_open_exit_case: true, idempotency_key: crypto.randomUUID() });
  expect([pending.status(), await codeOf(pending)]).toEqual([409, "rehire_exit_case_open"]);
  expect(await revision()).toEqual(exited);
  await expectAccessible(admin, "E3-rehire: prior exit decision remains open");

  await go(admin, path);
  const caseHref = await admin.getByRole("link", { name: "퇴직 건 열기", exact: true }).getAttribute("href");
  await go(admin, caseHref!);
  await admin.getByRole("region", { name: /지금/ }).getByRole("button", { name: "퇴직 본사 확인 1명 적용", exact: true }).click();
  await expect(admin.getByRole("main")).toContainText("본사 확인됨");

  // The rehire sheet: nothing chosen; a commit names every gap and writes nothing.
  await go(admin, `${path}?act=rehire`);
  const sheet = admin.getByRole("dialog", { name: "재입사로 등록" });
  await expect(sheet).toContainText("퇴직 정산·결재 절차");
  await expect(sheet).toContainText("정산 완료 여부 확인 필요");
  const acknowledgement = sheet.getByRole("checkbox", { name: "이전 퇴직 건의 남은 절차를 확인했습니다", exact: true });
  await expect(acknowledgement).not.toBeChecked();
  await expect(sheet.getByRole("radiogroup", { name: /^어디에 둡니까/ }).getByRole("radio", { checked: true })).toHaveCount(0);
  // The record behind the sheet shifts once as its reads land; this check is about the sheet, so it starts after them.
  await expect(admin.getByText("불러오는 중")).toHaveCount(0);
  await forgetResize(admin);
  await sheet.getByRole("button", { name: /재입사 1명 (예약|적용)/ }).click();
  await expect(sheet).toContainText(/채울 것 \d+개/);
  expect((await revision()).status).toBe("EXITED");
  await expectAccessible(admin, "E3-rehire: gaps named");

  await sheet.getByRole("radiogroup", { name: /^어디에 둡니까/ }).getByText("부서에 둠", { exact: true }).click();
  await sheet.getByRole("combobox", { name: "둘 곳" }).pressSequentially("채용");
  await admin.getByRole("option", { name: /채용팀/ }).first().click();
  await fillDate(sheet, kstDate(0), "입사일");
  await sheet.getByRole("radiogroup", { name: /^고용형태/ }).getByText("정규직", { exact: true }).click();
  await sheet.getByRole("button", { name: /재입사 1명 (예약|적용)/ }).click();
  await expect(sheet).toBeVisible();
  expect((await revision()).status).toBe("EXITED");
  await statement(acknowledgement).click();
  await sheet.getByRole("button", { name: /재입사 1명 (예약|적용)/ }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  const after = await revision();
  expect(after.status).toBe("ACTIVE");
  // Once employed again, a second rehire is refused the same way.
  const twice = await api(`/employees/${id}/rehire`, "POST", { hire_date: kstDate(2), employment_type: "REGULAR", org_unit_id: unit, position: "사원", idempotency_key: crypto.randomUUID() });
  expect([twice.status(), await codeOf(twice)]).toEqual([409, "rehire_requires_exited"]);
});
