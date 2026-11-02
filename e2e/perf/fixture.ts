// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, type Browser, type Page } from "@playwright/test";
import { bizRegNoChecksumOk, corpRegNoChecksumOk } from "../../apps/web/src/lib/pure/formats";
import { chooseRadio, go, kstDate } from "../flows";
import { apiOf, bearerOf, headcount } from "../helpers/api";
import { firstWorkplace } from "../helpers/entity";
import { chooseWorkbook, payPeriod } from "../helpers/import";
import { many, plain, workbook } from "../helpers/import-layouts";
import { panel, quickWorkplace } from "../helpers/structure";
import { openTenant } from "../helpers/tenant";
import { REGISTRATION_FIXTURES, registerEntity, SETUP_DEPARTMENT, setupCompany, startOperations } from "../setup-flows";
import { fillDate, reasonBox, signOff, todayPreset } from "../sheet";
import { reasonChip } from "../helpers/lifecycle";
import { hrAct } from "../record";
import { budget } from "./budget";

/** Keep the unallocated prefix and use the product's checksum validators for additional fictional corporations. */
export function registration(index: number) {
  const next = (seed: string, valid: (value: string) => boolean) => {
    const body = String(Number(seed.slice(0, -1)) + index).padStart(seed.length - 1, "0");
    const digit = Array.from({ length: 10 }, (_, n) => n).find(n => valid(body + n));
    expect(body.startsWith("000") && digit !== undefined).toBe(true);
    return body + digit;
  };
  return { brn: next(REGISTRATION_FIXTURES.primary.brn, bizRegNoChecksumOk), crn: next(REGISTRATION_FIXTURES.primary.crn, corpRegNoChecksumOk) };
}

/** All writes use product controls. GET probes verify the saved shape and supply concrete route ids. */
export async function buildTenant(browser: Browser) {
  const admin = await openTenant(browser, "route-load", "가상성능그룹");
  admin.setDefaultTimeout(30_000);
  await admin.setViewportSize({ width: 1440, height: 900 });
  const token = bearerOf(admin), api = apiOf(admin, token);
  const companies = Array.from({ length: budget.shape.entities }, (_, i) => `가상성능법인${i + 1}`);
  const places = Array.from({ length: budget.shape.workplaces }, (_, i) => `가상사업장${i + 1}`);
  const depts = Array.from({ length: budget.shape.departments }, (_, i) => i === 0 ? SETUP_DEPARTMENT : `가상부서${i + 1}`);
  await setupCompany(admin, companies[0]!, places[0]!);
  for (const [i, company] of companies.entries()) {
    if (i > 0) {
      await go(admin, "/org/entities/new");
      await registerEntity(admin, company, false, undefined, registration(i));
      await firstWorkplace(admin, company, places[i * places.length / companies.length]!);
    }
    for (let at = i * places.length / companies.length; at < (i + 1) * places.length / companies.length; at++) {
      const place = places[at]!;
      if (at % (places.length / companies.length) !== 0) {
        await quickWorkplace(admin, new RegExp(`주식회사 ${company}(?:\\s|$)`), place, { road: "서울특별시 강남구 테헤란로 152", zip: "06236" });
      }
    }
    const units = depts.filter((_, n) => Math.floor((n % places.length) / (places.length / companies.length)) === i);
    await go(admin, "/org/import");
    const chooser = admin.waitForEvent("filechooser");
    await admin.getByRole("button", { name: "파일 선택" }).click();
    const departments = depts.flatMap((name, n) => n !== 0 && units.includes(name) ? [[`주식회사 ${company}`, places[n % places.length]!, name]] : []);
    await (await chooser).setFiles({ name: "가상조직.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await workbook([{ name: "부서", lines: [["회사", "사업장", "부서"], ...departments] }]) });
    await expect(admin.getByLabel("사업장 열")).toHaveValue("workplace");
    await admin.getByRole("button", { name: "다음: 값 연결" }).click();
    await admin.locator("#values-head").waitFor();
    const pickName = new RegExp(`^주식회사 ${company} · 어디에`);
    const companySelect = admin.getByRole("combobox", { name: pickName });
    if (await companySelect.count()) await companySelect.selectOption({ label: `주식회사 ${company}` });
    else await admin.getByRole("radiogroup", { name: pickName }).getByText(`주식회사 ${company}`, { exact: true }).click();
    await admin.getByRole("button", { name: "다음: 미리보기" }).click();
    await admin.getByRole("button", { name: `${departments.length}건 적용`, exact: true }).click();
    await expect(admin.getByRole("status").filter({ hasText: "기록됨" })).toContainText(`부서 ${departments.length}개`);
    const rows = many(`000-${i + 1}`, budget.shape.employees / companies.length, units);
    for (let at = 0; at < rows.length; at += 200) {
      if (at === 0) await go(admin, "/people/import");
      else await admin.getByRole("link", { name: "다른 명부 가져오기", exact: true }).click();
      await chooseWorkbook(admin, `가상명부_${i + 1}_${at}.xlsx`, await workbook([plain(company, rows.slice(at, at + 200))]));
      await payPeriod(admin);
      await admin.getByRole("button", { name: "명부 미리보기" }).click();
      await admin.getByRole("button", { name: "모의 반영 실행" }).click();
      const applied = admin.waitForResponse(r => r.request().method() === "POST" && /\/employees\/import\/[^/]+\/apply$/.test(new URL(r.url()).pathname));
      await admin.getByRole("button", { name: "명부 반영: 신규 200명 · 갱신 0명" }).click();
      const response = await applied;
      expect([200, 202]).toContain(response.status());
      // Resume the active job when a delayed event-stream frame leaves the progress view behind.
      await expect(async () => {
        if (await admin.getByRole("heading", { name: "명부를 반영했습니다" }).isVisible()) return;
        await admin.reload();
        await expect(admin.getByRole("heading", { name: "명부를 반영했습니다" })).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 300_000, intervals: [5000] });
      await expect(admin.getByText("신규 200명 · 갱신 0명 · 건너뜀 0명")).toBeVisible();
    }
    console.log(`Synthetic tenant: ${i + 1}/${companies.length} entities and ${(i + 1) * rows.length} employees created through the UI`);
  }
  await startOperations(admin);
  expect(await headcount(api)).toBe(budget.shape.employees);
  const get = async (path: string) => {
    const response = await api(path);
    expect(response.status(), path).toBe(200);
    return response.json();
  };
  const entities = (await get("/legal-entities")).items as { id: string }[];
  const workplaces = (await get("/workplaces")).items as { id: string }[];
  const units = (await get("/org-units")).items as { id: string; name: string; kind: string }[];
  expect(entities).toHaveLength(budget.shape.entities);
  expect(workplaces).toHaveLength(budget.shape.workplaces);
  expect(units.filter(u => u.kind === "DEPARTMENT")).toHaveLength(budget.shape.departments);
  const person = (await get("/employees?limit=1&search=000-1-0001")).items[0] as { id: string };
  const me = await get("/users/me") as { id: string };
  const urls: Record<string, string> = {
    "/org/entities/$id": `/org/entities/${entities[0]!.id}`,
    "/org/entities/$id/workplaces/new": `/org/entities/${entities[0]!.id}/workplaces/new`,
    "/people/$id": `/people/${person.id}`,
    "/people/$id/identifiers": `/people/${person.id}/identifiers`,
    "/access/people/$accountId": `/access/people/${me.id}`,
  };
  await recordRoutes(admin, urls, depts, units.find(u => u.name === depts.at(-1))!.id);
  expect(await headcount(api)).toBe(budget.shape.employees);
  return { admin, urls };
}

async function recordRoutes(admin: Page, urls: Record<string, string>, depts: string[], departmentId: string) {
  await go(admin, "/access/roles/new");
  await admin.getByRole("textbox", { name: /^역할 이름/ }).fill("가상 조회 역할");
  await admin.getByRole("checkbox", { name: "인사기본 조회" }).click();
  const role = admin.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/access/roles");
  await admin.getByRole("button", { name: "역할 추가" }).click();
  expect((await role).status()).toBe(201);
  urls["/access/roles/$roleId"] = `/access/roles/${(await (await role).json()).id as string}`;

  await go(admin, urls["/people/$id"]!);
  await hrAct(admin, "전보");
  const transfer = admin.getByRole("dialog", { name: /전보/ });
  await transfer.getByRole("combobox", { name: "어디로" }).fill(depts[budget.shape.workplaces]!);
  await admin.getByRole("option", { name: new RegExp(`${depts[budget.shape.workplaces]!}(?:\\s|$)`) }).click();
  await fillDate(transfer, kstDate(7));
  await reasonChip(transfer, "조직 개편").click();
  await reasonBox(transfer).fill("가상 성능 측정용 발령");
  await signOff(transfer);
  const event = admin.waitForRequest(r => r.method() === "POST" && /\/lifecycle-events$/.test(new URL(r.url()).pathname));
  await transfer.getByRole("button", { name: /^전보 1명 예약/ }).click();
  urls["/requests/$id"] = `/requests/${(await event).headers()["idempotency-key"]!}`;
  await expect(transfer).toBeHidden();
  await go(admin, "/people/notices/new");
  await admin.getByRole("checkbox", { name: /전보/ }).first().check();
  await todayPreset(admin).click();
  await admin.getByRole("button", { name: /^공고 작성/ }).click();
  await admin.waitForURL(/\/people\/notices\/[0-9a-f-]+$/);
  urls["/people/notices/$noticeId"] = new URL(admin.url()).pathname;

  await go(admin, urls["/people/$id"]!);
  await admin.getByRole("button", { name: "퇴직 보고" }).press("Enter");
  const exit = admin.getByRole("dialog", { name: /퇴직 보고/ });
  await fillDate(exit, kstDate(30), "마지막 근무일");
  await exit.getByLabel("퇴직 경위").fill("가상 퇴직 예정");
  await exit.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  const reported = admin.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/v1/hr/exit-cases");
  await exit.getByRole("button", { name: "퇴직 보고 1명 적용" }).click();
  expect((await reported).status()).toBe(201);
  urls["/people/exits/$id"] = `/people/exits/${(await (await reported).json()).id as string}`;
  await expect(exit).toBeHidden();

  await go(admin, "/people/certificates");
  await admin.getByRole("button", { name: "번호·직인 설정" }).click();
  await chooseRadio(admin.getByRole("dialog"), /주식회사 가상성능법인1/);
  await admin.getByLabel(/^번호 접두어/).fill("LAB");
  await admin.getByLabel(/^일련번호 자릿수/).fill("6");
  await admin.getByLabel(/^직인 표기/).fill("가상성능법인 대표이사");
  await admin.getByRole("button", { name: "설정 저장" }).click();
  await admin.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await go(admin, urls["/people/$id"]!);
  await admin.getByRole("button", { name: "증명서", exact: true }).press("Enter");
  const certificate = admin.getByRole("dialog", { name: "증명서 발급" });
  await chooseRadio(certificate, /재직증명서/);
  await certificate.getByRole("checkbox", { name: "사용 기간" }).locator("xpath=ancestor::label[1]").click();
  await certificate.getByLabel(/^제출 목적/).fill("가상 성능 측정");
  await certificate.getByRole("button", { name: "발급", exact: true }).click();
  await admin.waitForURL(/\/people\/certificates\/[0-9a-f-]+$/);
  urls["/people/certificates/$certificateId"] = new URL(admin.url()).pathname;

  await go(admin, `/org?sel=${departmentId}`);
  const selected = panel(admin, depts.at(-1)!);
  await expect(selected).toBeVisible();
  await selected.getByRole("button", { name: "이름 변경" }).click();
  const rename = admin.getByRole("dialog", { name: `${depts.at(-1)!} 이름 변경` });
  await rename.getByRole("textbox", { name: /^새 이름/ }).fill("가상미래부서");
  await rename.getByRole("textbox", { name: /^시행일/ }).fill(kstDate(14));
  await rename.getByRole("textbox", { name: /^사유/ }).fill("가상 성능 측정");
  const change = admin.waitForResponse(r => r.request().method() === "POST" && /\/org-changes\/[^/]+\/submit$/.test(new URL(r.url()).pathname));
  await rename.getByRole("button", { name: "부서 이름 변경 1개 예약" }).click();
  expect((await change).status()).toBe(200);
  urls["/org/changes/$id"] = `/org/changes/${new URL((await change).url()).pathname.split("/").at(-2)!}`;
  await expect(rename).toBeHidden();
}
