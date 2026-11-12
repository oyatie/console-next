// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import type { components } from "@console/api/schema";
import { fmtDate } from "@console/i18n/format";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { tenantOnboardSubmit, tenantSlugField, firstSignIn, go, kstDate, option, takeCode, unique, vendorPage } from "./flows";
import { addDepartments, leaveScreen } from "./structure-flows";
import { firstWorkplace, registerAt } from "./helpers/entity";
import { answer, registerBranch, registerEntity, SECOND, setupCompany, setupRail, startOperations, REGISTRATION_FIXTURES, brnDisplay } from "./setup-flows";
import { apiOf, bearerOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { hrAct, openHistory } from "./record";
import { fillDate, reasonBox, sheet, signOff } from "./sheet";
import { reasonChip } from "./helpers/lifecycle";

// One tenant, two 법인 (a group): each has its own registration, workplace and people, and every person is placed
// by id at one 법인 and one of its 사업장.

test("a group of two legal entities: each with its workplace and people, placed by id", { tag: "@first-run" }, async ({ browser }) => {
  const v = await vendorPage(browser);
  await go(v, "/platform");
  await v.getByRole("button", { name: "고객 계정 개설" }).click();
  await v.getByLabel("고객 이름").fill("가나그룹");
  await tenantSlugField(v).fill(unique("ganagroup"));
  await tenantOnboardSubmit(v).click();
  const admin = await firstSignIn(browser, await takeCode(v));

  await setupRail(admin).getByRole("link", { name: "법인 등록" }).first().click();
  await registerEntity(admin, "가나홀딩스");
  await firstWorkplace(admin, "가나홀딩스", "본사");
  // The second 법인: its own 사업자등록번호 and 법인등록번호.
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "가나랩", false, undefined, SECOND);
  await firstWorkplace(admin, "가나랩", "연구소");

  await go(admin, "/org/entities");
  const list = admin.getByRole("grid", { name: "법인 목록" });
  for (const column of ["법인명", "구분", "대표 등록번호", "사업장", "재직", "확인"])
    await expect(list.getByRole("columnheader", { name: column, exact: true })).toBeVisible();
  // The LongTable migration (ebdc131a2b) names each row by its row header; facts remain in their cells.
  for (const [name, registration] of [["가나홀딩스", REGISTRATION_FIXTURES.primary], ["가나랩", REGISTRATION_FIXTURES.second]] as const) {
    const row = list.getByRole("row", { name: `주식회사 ${name}`, exact: true });
    await expect(row.getByRole("gridcell", { name: brnDisplay(registration.brn), exact: true })).toBeVisible();
    await expect(row.getByRole("gridcell", { name: "1곳", exact: true })).toBeVisible();
  }
  await expectAccessible(admin, "entity list (two entities)");

  // A dated change, twice: each save carries the revision it read, so the second one is not refused as stale.
  await list.getByRole("row", { name: /주식회사 가나랩/ }).click();
  await expect(admin.getByRole("heading", { name: /가나랩/, level: 1 })).toBeVisible();
  for (const phone of ["02-1234-5678", "02-8765-4321"]) {
    await admin.getByRole("button", { name: "대표전화 수정" }).click();
    const edit = admin.getByRole("dialog", { name: "대표전화 수정" });
    await option(admin, "무엇을 기록합니까", "대표전화가 바뀌었습니다 · 변경").click();
    await option(admin, "언제부터 바뀝니까", `오늘 (${fmtDate(kstDate())})`).click();
    await edit.getByRole("textbox", { name: /^대표전화/ }).fill(phone);
    await edit.getByRole("button", { name: "변경 기록" }).click();
    await expect(edit).toBeHidden();
    await expect(admin.getByText(phone, { exact: true }).first()).toBeVisible();
  }

  await go(admin, "/org");
  for (const [place, unit] of [["본사", "경영지원팀"], ["연구소", "연구팀"]] as const) await addDepartments(admin, place, [unit]);
  await expectAccessible(admin, "setup org (two entities)");

  await registerAt(admin, "김지원", "가나홀딩스", "경영지원");
  // The head's 소속 (the placement history beside it links the same place under the same name).
  const head = admin.getByRole("group", { name: "소속", exact: true });
  await expect(head.getByRole("link", { name: "본사" })).toBeVisible();
  const researcher = await registerAt(admin, "박연구", "가나랩", "연구팀");
  await expect(head.getByRole("link", { name: "연구소" })).toBeVisible();

  // Each entity counts its own people.
  await go(admin, "/org/entities");
  for (const name of ["가나홀딩스", "가나랩"])
    await expect(list.getByRole("row", { name: `주식회사 ${name}`, exact: true }).getByRole("gridcell", { name: "1명", exact: true })).toBeVisible();

  // The newest bearer the app itself sent (memory only). Nothing re-reads on a timer (decision #27), so the next
  // screen may well send no request at all: track every request from here instead of waiting for the next one.
  let bearer = "";
  admin.on("request", (r) => {
    const h = r.headers()["authorization"];
    if (h && r.url().includes("/api/v1/")) bearer = h;
  });
  await startOperations(admin);

  // 전적 cannot happen by accident through the placement path: a change of 법인 is refused with its remedy.
  await go(admin, "/org/entities");
  const headers = { authorization: bearer };
  const entities = (await (await admin.request.get("/api/v1/legal-entities", { headers })).json()) as { items: { id: string; current?: { name: string }; workplaces: { id: string }[] }[] };
  const holdings = entities.items.find((e) => e.current?.name === "주식회사 가나홀딩스")!;
  const moved = await admin.request.post("/api/v1/employment-assignments", {
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
    data: { employee_id: researcher, legal_entity_id: holdings.id, workplace_id: holdings.workplaces[0]!.id, valid_from: kstDate(1) },
  });
  expect(moved.status()).toBe(409);
  const refused = (await moved.json()) as { error: { code: string; reasons?: string[] } };
  expect(refused.error.code).toBe("entity_change_needs_group_transfer");
  expect(refused.error.reasons).toContain("start_group_transfer");
});

test("a transfer between two workplaces of one legal entity moves the placement on its date", async ({ browser }) => {
  const admin = await openTenant(browser, "workplacemove", "전근상사");
  const api = apiOf(admin, bearerOf(admin));
  await setupCompany(admin, "전근상사", "본사");
  await registerBranch(admin, "전근상사", "공장", REGISTRATION_FIXTURES.branch_primary.brn);
  await go(admin, "/org");
  await addDepartments(admin, "본사", ["지원팀"]);
  await addDepartments(admin, "공장", ["생산팀"]);
  const hired = kstDate(-30);
  const person = await registerAt(admin, "김전근", "전근상사", "지원팀", undefined, hired);
  const record = new URL(admin.url()).pathname;
  await startOperations(admin);
  await leaveScreen(admin);
  const placements = async () => {
    const response = await api(`/employment-assignments?employee_id=${person}`);
    expect(response.status()).toBe(200);
    return (await response.json() as components["schemas"]["EmploymentAssignmentList"]).items;
  };
  const before = await placements();
  expect(before).toHaveLength(1);
  await go(admin, record);
  await hrAct(admin, "전보");
  const transfer = sheet(admin);
  await expect(transfer).toContainText("김전근");
  await transfer.getByRole("combobox", { name: "어디로" }).fill("생산팀");
  await admin.getByRole("option", { name: /생산팀/ }).click();
  const on = kstDate(-2);
  await fillDate(transfer, on);
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("생산 지원");
  await signOff(transfer);
  await expectAccessible(admin, "workplace transfer effective date");
  await atPhoneWidth(admin, async () => {
    for (const theme of ["light", "dark"]) {
      await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
      await fits(admin, "workplace transfer");
    }
  });
  const recorded = answer(admin, "POST", /\/lifecycle-events$/);
  await transfer.getByRole("button", { name: "전근 1명 적용", exact: true }).click();
  const response = await recorded;
  expect(response.status()).toBe(200);
  const event = await response.json() as components["schemas"]["EmployeeLifecycleEvent"];
  await expect(transfer).toBeHidden();
  const after = await placements();
  expect(after).toHaveLength(2);
  expect(after.find(p => p.valid_from === hired)).toMatchObject({ workplace_id: before[0]!.workplace_id, valid_to: on });
  const moved = after.find(p => p.valid_from === on)!;
  expect(moved).toMatchObject({ legal_entity_id: before[0]!.legal_entity_id, cause: "TRANSFER", valid_to: null });
  expect(moved.workplace_id).not.toBe(before[0]!.workplace_id);
  expect(event.to_workplace_id).toBe(moved.workplace_id);
  await expect(admin.getByRole("group", { name: "소속", exact: true }).getByRole("link", { name: "공장", exact: true })).toBeVisible();
  await openHistory(admin);
  await expect(admin.getByRole("region", { name: "인사 이력" }).getByRole("listitem").filter({ hasText: "생산 지원" })).toContainText("생산팀");
});

// 전적 (a move between 법인) with consent and a continuity choice: group-transfer.spec.ts.
