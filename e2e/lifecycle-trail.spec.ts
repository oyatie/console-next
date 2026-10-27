// SPDX-License-Identifier: LicenseRef-Proprietary
import { commitLabel } from "../apps/web/src/ui/composer/actions";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { components } from "@console/api/schema";
import type { FilingPage, FilingTask } from "@console/api/pending";
import { isMessageId, loadCatalog, t } from "@console/i18n";
import { filingLabel } from "../apps/web/src/features/statutory/present";
import { atPhoneWidth, expectAccessible, fits } from "./a11y";
import { apiAs, soloTenant } from "./chaos";
import { chooseRadio, go, kstDate, registerEmployee, routeReady, stepUp, takeCode } from "./flows";
import { firstWorkplace, registerAt } from "./helpers/entity";
import { fillRegister, openRegistered, pressRegister, registerSheet } from "./helpers/register";
import { hrAct, openCard, openHistory } from "./record";
import { SETUP_DEPARTMENT, SECOND, REGISTRATION_FIXTURES, registerBranch, registerEntity, setupCompany, startOperations } from "./setup-flows";
import { addDepartments, leaveScreen } from "./structure-flows";
import { reasonChip } from "./helpers/lifecycle";
import { prepareFilingCompletion } from "./helpers/statutory";
import { holdRead } from "./helpers/read";
import { releaseChangeRules } from "./helpers/filing-register";
import { fillDate, reasonBox, signOff, todayPreset } from "./sheet";

type Case = components["schemas"]["LifecycleCase"];
type Item = components["schemas"]["LifecycleCaseItem"];
type Event = components["schemas"]["EmployeeLifecycleEvent"];
type Filing = FilingTask & { filing_obligation_id: string | null };
type Filings = Omit<FilingPage, "items"> & { items: Filing[] };
const title = "서류 · 법정 기한 · 할 일";

test.beforeAll(() => loadCatalog("ko"));

async function audit(page: Page, context: string) {
  await expectAccessible(page, `${context}: 1440px, light and dark`);
  await atPhoneWidth(page, async () => {
    await fits(page, context);
    await expectAccessible(page, `${context}: 390px, light and dark`);
  });
}

async function expectWindow(row: Locator, item: Item) {
  if (item.status_code === "PRE_CONSOLE" || (!item.due_rule_ref && !item.opens_rule_ref)) {
    await expect(row).not.toContainText("시작 미확인");
    await expect(row).not.toContainText("기한 미확인");
    await expect(row.locator("time")).toHaveCount(0);
    return;
  }
  await expect(row).toContainText("시작");
  await expect(row).toContainText("기한");
  await expect(row).not.toContainText("목표");
  if (item.opens_on) await expect(row.locator(`time[datetime="${item.opens_on}"]`).first()).toBeVisible();
  if (item.due_disposition === "UNKNOWN") {
    await expect(row).toContainText("기한 미확인");
    await expect(row).not.toContainText(/D-\d/);
  } else if (item.due_date) {
    await expect(row.locator(`time[datetime="${item.due_date}"]`).last()).toBeVisible();
    await expect(row).toContainText(/D-\d+|오늘까지|기한 지남/);
  }
}

test("past hires use the go-live boundary in the preview and case, including setup registrations", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await soloTenant(browser, "trail-history", "과거입사회사");
  await setupCompany(admin, "과거입사회사", "본사");
  const read = apiAs(admin);
  const hired = kstDate(-90);
  await go(admin, "/people/new");
  await fillRegister(admin, { name: "한준비", number: "TRAIL-SETUP", hired, unit: SETUP_DEPARTMENT });
  const setupPreview = registerSheet(admin).locator('[data-composer-section="deadlines"] [data-trail-preview-item]');
  await expect(setupPreview).toHaveCount(4);
  // Go-live commits at now(), so expired filings already precede its earliest possible boundary.
  for (const row of await setupPreview.all()) {
    await expect(row).toContainText("운영 시작 전");
    await expect(row).not.toContainText("기한 지남");
    await expect(row.locator("time")).toHaveCount(0);
  }
  await pressRegister(admin);
  await openRegistered(admin, "한준비", "TRAIL-SETUP");
  const setupPerson = new URL(admin.url()).pathname.split("/").pop()!;
  const setupCases = await read<Case[]>(`/api/v1/employees/${setupPerson}/lifecycle-cases`);
  expect(setupCases[0]!.items.filter((item) => item.kind === "FIL").every((item) => item.status === "NOT_APPLICABLE" && item.status_code === "PRE_CONSOLE")).toBe(true);
  await startOperations(admin);
  await leaveScreen(admin);
  const historical = await read<Case[]>(`/api/v1/employees/${setupPerson}/lifecycle-cases`);
  const filings = historical[0]!.items.filter((item) => item.kind === "FIL");
  expect(filings).toHaveLength(4);
  expect(filings.every((item) => item.status === "NOT_APPLICABLE" && item.status_code === "PRE_CONSOLE" && !item.opens_on && !item.due_date)).toBe(true);
  await go(admin, "/people/new");
  await fillRegister(admin, { name: "한과거", number: "TRAIL-PAST", hired, unit: "본사" });
  const preview = registerSheet(admin).locator('[data-composer-section="deadlines"] [data-trail-preview-item]');
  await expect(preview).toHaveCount(filings.length);
  for (const row of await preview.all()) {
    await expect(row).toContainText("운영 시작 전");
    await expect(row).not.toContainText("기한 지남");
    await expect(row).not.toContainText(/D-\d/);
    await expect(row.locator("time")).toHaveCount(0);
  }
  await audit(admin, "past hire composer preview");
  await pressRegister(admin);
  await openRegistered(admin, "한과거", "TRAIL-PAST");
  const person = new URL(admin.url()).pathname.split("/").pop()!;
  const cases = await read<Case[]>(`/api/v1/employees/${person}/lifecycle-cases`);
  const past = cases[0]!.items.filter((item) => item.kind === "FIL");
  expect(past).toHaveLength(filings.length);
  expect(past.every((item) => item.status === "NOT_APPLICABLE" && item.status_code === "PRE_CONSOLE")).toBe(true);
  // Pasted raw query values must reach the same committed, ready sheet as serialized links.
  await go(admin, `/people/${person}?act=case:${cases[0]!.id}`);
  const trail = admin.getByRole("dialog", { name: title, exact: true });
  for (const item of past) await expect(trail.locator(`[id="item-${item.id}"]`)).toContainText("운영 시작 전");
  await expect(trail).not.toContainText("기한 지남");
});

test("a solo hire and exit share their filings and show every administrative leg", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await soloTenant(browser, "trail-exit", "사건기록회사");
  await admin.setViewportSize({ width: 1440, height: 1000 });
  await setupCompany(admin, "사건기록회사", "본사");
  await startOperations(admin); await leaveScreen(admin);
  const read = apiAs(admin);
  await go(admin, "/people/new");
  await fillRegister(admin, { name: "한기록", number: "TRAIL-1", hired: kstDate(), unit: "본사" });
  const hirePreview = registerSheet(admin).locator('[data-composer-section="deadlines"] [data-trail-preview-item]');
  await expect(hirePreview).toHaveCount(4);
  for (const row of await hirePreview.all()) {
    await expect(row).toContainText("시작");
    await expect(row).toContainText("기한");
    await expect(row.locator("time")).toHaveCount(2);
    await expect(row).not.toContainText(/[A-Za-z_]{2,}\.[a-z_.]+|[A-Z]{2,}_[A-Z_]+/);
  }
  const hirePreviewKeys = await hirePreview.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-trail-preview-item")));
  await audit(admin, "hire composer trail preview");
  await pressRegister(admin);
  await openRegistered(admin, "한기록", "TRAIL-1");
  const person = new URL(admin.url()).pathname.split("/").pop()!;
  const cases = await read<Case[]>(`/api/v1/employees/${person}/lifecycle-cases`);
  const hires = cases.filter((value) => value.kind === "HIRE");
  expect(hires).toHaveLength(1);
  const hire = hires[0]!;
  expect(hirePreviewKeys.sort()).toEqual(hire.items.filter((item) => item.kind === "FIL").map((item) => item.item_key).sort());
  const acquisitions = (await read<Filings>(`/api/v1/statutory/insurance-filings?event_id=${hire.trigger_id}`)).items;
  expect(acquisitions.length).toBeGreaterThan(0);
  expect(acquisitions.every((filing) => filing.kind === "ACQUIRE")).toBe(true);
  expect(hire.items.filter((item) => item.kind === "FIL").map((item) => item.filing_obligation_id).sort())
    .toEqual(acquisitions.map((filing) => filing.filing_obligation_id).sort());
  await expect(admin.getByRole("region", { name: title, exact: true })).toContainText("신고");

  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력", exact: true });
  const hireEntry = history.locator(`[id="ev-${hire.trigger_id}"]`);
  await hireEntry.getByRole("button", { name: title, exact: true }).click();
  const sheet = admin.getByRole("dialog", { name: title, exact: true });
  for (const filing of acquisitions) {
    const item = hire.items.find((candidate) => candidate.filing_obligation_id === filing.filing_obligation_id)!;
    const row = sheet.getByRole("listitem").filter({ has: admin.getByText(`${filingLabel(filing.insurer)} ${filingLabel(filing.kind)}`, { exact: true }) });
    await expect(row).toHaveCount(1);
    await expectWindow(row, item);
  }
  await audit(admin, "hire trail from employee history");
  const acquisition = hire.items.find((item) => item.kind === "FIL" && item.insurer === "NPS")!;
  await sheet.getByRole("listitem").filter({ has: admin.getByText("국민연금 취득 신고", { exact: true }) }).getByRole("link", { name: "신고 처리 기록", exact: true }).click();
  await expect(admin).toHaveURL(new RegExp(`filing=${acquisition.filing_obligation_id}`));
  const filingDialog = admin.getByRole("dialog");
  await expect(filingDialog).toBeVisible();
  await prepareFilingCompletion(admin, filingDialog);
  await fillDate(filingDialog, kstDate(), "신고일");
  await filingDialog.getByLabel(/^접수번호/).fill("TRAIL-NPS-RECEIPT");
  await audit(admin, "linked statutory filing dialog");
  await filingDialog.getByRole("button", { name: "미리보기", exact: true }).click();
  await filingDialog.getByRole("button", { name: "신고 완료", exact: true }).click();
  await expect(filingDialog).toBeHidden();
  await admin.getByRole("link", { name: "사건 보기", exact: true }).click();
  const reopened = admin.getByRole("dialog", { name: title, exact: true });
  const recordedItem = reopened.getByRole("listitem").filter({ has: admin.getByText("국민연금 취득 신고", { exact: true }) });
  await expect(recordedItem).toContainText("시스템 확인 완료");
  await expect(recordedItem.getByRole("link", { name: "신고 접수 기록", exact: true })).toBeVisible();
  await expect(recordedItem.locator("code")).toHaveCount(0);
  await reopened.getByRole("button", { name: "닫기", exact: true }).last().click();

  // Invite on this employee so the exit has an actual linked account to end.
  await openCard(admin);
  await admin.getByRole("button", { name: "계정 초대", exact: true }).click();
  await stepUp(admin.getByRole("dialog", { name: "계정 초대", exact: true }), "패스키로 확인하고 계정 초대", admin.getByLabel("일회용 코드"));
  await takeCode(admin); await leaveScreen(admin);
  await go(admin, `/people/${person}`);
  await admin.getByRole("button", { name: "퇴직 보고", exact: true }).click();
  const report = admin.getByRole("dialog");
  await fillDate(report, kstDate(), "마지막 근무일");
  await report.getByLabel("퇴직 경위").fill("개인 사정으로 퇴직");
  await report.getByRole("radiogroup", { name: /^퇴직 사유/ }).getByText("개인 사정", { exact: true }).click();
  await expect(report.locator("[data-trail-preview-item]").first()).toBeVisible();
  const exitPreview = await report.locator("[data-trail-preview-item]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-trail-preview-item")));
  await audit(admin, "exit composer trail preview");
  const exitPanel = admin.getByRole("region", { name: "퇴직", exact: true });
  const heldTrail = await holdRead(admin, `**/api/v1/employees/${person}/lifecycle-cases`);
  try {
    await report.getByRole("button", { name: /^퇴직 보고 1명 적용/ }).click();
    await heldTrail.requested;
    await expect(report).toBeHidden();
    await expect(exitPanel.getByRole("status")).toContainText("퇴직을 보고했습니다");
  } finally {
    await heldTrail.release();
  }
  await exitPanel.getByRole("button", { name: "인사 확인하고 퇴직 처리", exact: true }).click();
  await signOff(admin.getByRole("dialog").getByRole("group", { name: "확인 사항" }));
  await admin.getByRole("dialog").getByRole("button", { name: /^퇴직 1명 (적용|예약)/ }).click();
  await expect(admin.getByRole("dialog")).toBeHidden();
  const exitHref = await exitPanel.getByRole("link", { name: "퇴직 건 열기", exact: true }).getAttribute("href");
  await go(admin, exitHref!);
  const exits = (await read<Case[]>(`/api/v1/employees/${person}/lifecycle-cases`)).filter((value) => value.kind === "EXIT");
  expect(exits).toHaveLength(1);
  const exit = exits[0]!;
  expect(exitPreview.sort()).toEqual(exit.items.map((item) => item.item_key).sort());
  const trail = admin.getByRole("region", { name: title, exact: true });
  for (const item of exit.items) {
    const label = item.filing_kind && item.insurer ? `${filingLabel(item.insurer)} ${filingLabel(item.filing_kind)}` : item.label_key && isMessageId(item.label_key) ? t(item.label_key) : item.label;
    await expect(trail.getByText(label, { exact: true }).first()).toBeVisible();
  }
  for (const label of ["상실 신고", "이직확인서", "사용증명서", "접근 권한 회수", "업무 인수인계", "회사 자산·자료 반납", "금품청산"]) {
    await expect(trail).toContainText(label);
  }
  const access = exit.items.filter((item) => item.kind === "ACC");
  expect(access.length).toBeGreaterThan(0);
  for (const item of access) {
    expect(item.status).toBe("DONE_OBSERVED");
    expect(item.observed_ref?.table).toBe("audit_events");
  }
  const accessRow = trail.getByRole("listitem").filter({ hasText: "접근 권한 회수" });
  await expect(accessRow).toContainText("시스템 확인 완료");
  await expectWindow(accessRow, access[0]!);
  await audit(admin, "exit page with every trail leg");
});

test("one intercompany transfer shows two linked cases in one history entry and receipt", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await soloTenant(browser, "trail-transfer", "사건그룹");
  await admin.setViewportSize({ width: 1440, height: 1000 });
  await setupCompany(admin, "사건그룹", "본사");
  await go(admin, "/org/entities/new");
  await registerEntity(admin, "사건연구", false, undefined, SECOND);
  await firstWorkplace(admin, "사건연구", "연구소");
  await startOperations(admin);
  await leaveScreen(admin);
  const read = apiAs(admin);
  const person = await registerAt(admin, "강연결", "사건그룹", "본사", undefined, kstDate(-30));
  await hrAct(admin, "전적");
  const transfer = admin.getByRole("dialog", { name: "전적", exact: true });
  await transfer.getByLabel(/^동의 증빙/).fill("전적 동의서 서명본");
  await transfer.getByLabel(/^동의일/).fill(kstDate());
  await transfer.getByRole("combobox", { name: "어느 법인으로" }).fill("연구소");
  await admin.getByRole("option", { name: /연구소/ }).click();
  await todayPreset(transfer).click();
  await chooseRadio(transfer, /^퇴직금 지급/);
  await chooseRadio(transfer, /^남은 연차 수당 지급/);
  await chooseRadio(transfer, /^새 법인 근속은/);
  await transfer.getByRole("button", { name: /^입사일과 같게/ }).click();
  await reasonBox(transfer).fill("법인 간 연구 업무 전적");
  await expect(transfer.locator('[data-trail-preview-item="GT1"]')).toBeVisible();
  const groupPreview = await transfer.locator("[data-trail-preview-item]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-trail-preview-item")));
  await audit(admin, "intercompany composer trail preview");
  const response = admin.waitForResponse((answer) => answer.request().method() === "POST" && new URL(answer.url()).pathname === `/api/v1/employees/${person}/lifecycle-events`);
  await transfer.getByRole("button", { name: commitLabel({ kind: "GROUP_TRANSFER", mode: "apply", count: 1 }), exact: true }).click();
  const recorded = await response;
  expect(recorded.status()).toBe(200);
  const event = await recorded.json() as Event;
  await expect(transfer).toBeHidden();
  const cases = await read<Case[]>(`/api/v1/employees/${person}/lifecycle-cases`);
  const receiving = cases.filter((value) => value.kind === "HIRE" && value.trigger_id === event.id);
  expect(receiving).toHaveLength(1);
  const hire = receiving[0]!;
  const sending = cases.filter((value) => value.id === hire.linked_case_id);
  expect(sending).toHaveLength(1);
  expect(sending[0]).toMatchObject({ kind: "EXIT", linked_case_id: hire.id });
  expect(groupPreview.sort()).toEqual([...hire.items, ...sending[0]!.items].map((item) => item.item_key).sort());
  const events = await read<{ items: Event[] }>(`/api/v1/employees/${person}/lifecycle-events`);
  expect(events.items.filter((value) => value.event_type === "GROUP_TRANSFER")).toHaveLength(1);
  await openHistory(admin);
  const history = admin.getByRole("region", { name: "인사 이력", exact: true });
  const entry = history.locator(`[id="ev-${event.id}"]`);
  await expect(entry).toHaveCount(1);
  await expect(history.getByRole("status").filter({ hasText: /강연결.*전적했습니다/ })).toHaveCount(1);
  await entry.getByRole("button", { name: title, exact: true }).click();
  const sheet = admin.getByRole("dialog", { name: title, exact: true });
  await expect(sheet.getByRole("region", { name: "신고", exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "연결된 전적 사건", exact: true }).click();
  const linked = admin.getByRole("dialog", { name: "연결된 전적 사건", exact: true });
  await expect(linked).toContainText("퇴직");
  await expect(linked).toContainText("상실 신고");
  await expect(linked).toContainText("금품청산");
  await audit(admin, "linked intercompany transfer trail");
});

test("a solo admin attests a named document and closes a hire case from the card", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await soloTenant(browser, "trail-complete", "사건완료회사");
  await admin.setViewportSize({ width: 1440, height: 1000 });
  await setupCompany(admin, "사건완료회사", "본사");
  await startOperations(admin); await leaveScreen(admin);
  await registerEmployee(admin, { name: "한완료", number: "TRAIL-CLOSE", hired: kstDate(-30), unit: "본사" });
  const trail = admin.getByRole("region", { name: title, exact: true });
  const document = trail.getByRole("listitem").filter({ has: admin.getByText("입사 서류 · 근로계약 확인", { exact: true }) });
  await document.getByRole("button", { name: "증빙 확인 완료", exact: true }).click();
  const dialog = admin.getByRole("dialog", { name: "증빙 확인 완료", exact: true });
  await fillDate(dialog, kstDate(), "확인일");
  const documentName = "서명한 입사 계약서".repeat(6);
  await dialog.getByLabel(/^증빙 이름/).fill(documentName);
  await dialog.getByLabel(/^증빙 링크/).fill("https://evidence.example/hire-contract.pdf");
  await chooseRadio(dialog, /^기타/);
  await dialog.getByLabel(/^확인 내용/).fill("서명본을 확인하고 입사 서류 처리를 마침");
  await expect(dialog.getByLabel(/예외 처리 기록 ID/)).toHaveCount(0);
  await audit(admin, "governed lifecycle attestation");
  await dialog.getByRole("button", { name: "패스키로 확인하고 증빙 확인 완료", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(document).toContainText("증빙 확인 완료");
  await expect(document.getByRole("link", { name: documentName, exact: true })).toHaveAttribute("href", "https://evidence.example/hire-contract.pdf");
  await trail.getByRole("button", { name: "처리 종료", exact: true }).click();
  await expect(trail).toContainText("종료");
  await expect(trail.getByRole("button", { name: "처리 종료", exact: true })).toHaveCount(0);
  await audit(admin, "closed hire case with named evidence");
});

for (const released of [false, true]) {
test(`a workplace appointment ${released ? "records released filings and closes @clock" : "shows pending legal review and closes"}`, { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const admin = await soloTenant(browser, "trail-workplace", "사업장사건회사");
  await admin.setViewportSize({ width: 1440, height: 1000 });
  await setupCompany(admin, "사업장사건회사", "본사");
  await registerBranch(admin, "사업장사건회사", "지점", REGISTRATION_FIXTURES.branch_primary.brn);
  await go(admin, "/org");
  await addDepartments(admin, "지점", ["지점업무"]);
  await startOperations(admin);
  await leaveScreen(admin);
  const read = apiAs(admin);
  await go(admin, "/people/new");
  const extra = registerSheet(admin).getByRole("group", { name: "추가 정보", exact: true });
  await expect(extra).toBeVisible();
  const before = await extra.boundingBox();
  await fillRegister(admin, { name: "한발령", unit: "본사", hired: kstDate(-30) });
  expect((await extra.boundingBox())?.y).toBe(before?.y);
  await audit(admin, "past-hire registration form");
  await pressRegister(admin);
  await openRegistered(admin, "한발령");
  const person = new URL(admin.url()).pathname.split("/").pop()!;
  const restore = released ? releaseChangeRules() : undefined;
  try {
  await hrAct(admin, "전보");
  const transfer = admin.getByRole("dialog", { name: "전보", exact: true });
  await transfer.getByRole("combobox", { name: "어디로" }).fill("지점업무");
  await admin.getByRole("option", { name: /지점업무/ }).click();
  await todayPreset(transfer).click();
  await reasonChip(transfer, "업무 필요").click();
  await reasonBox(transfer).fill("지점 사업장으로 발령");
  const previewFilings = transfer.locator('[data-composer-section="deadlines"] [data-trail-preview-item]');
  await expect(previewFilings).toHaveCount(4);
  for (const row of await previewFilings.all()) {
    if (!released) await expect(row).toContainText("법무 검토 전");
    await expect(row).toContainText("시작");
    await expect(row).toContainText("기한 미확인");
    await expect(row.locator(`time[datetime="${kstDate()}"]`)).toHaveCount(1);
    await expect(row).not.toContainText(/[A-Za-z_]{2,}\.[a-z_.]+|[A-Z]{2,}_[A-Z_]+/);
  }
  const preview = await transfer.locator("[data-trail-preview-item]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-trail-preview-item")));
  await audit(admin, "workplace composer trail preview");
  await transfer.getByRole("button", { name: "전보 1명 적용", exact: true }).click();
  await expect(transfer).toBeHidden();
  const cases = await read<Case[]>(`/api/v1/employees/${person}/lifecycle-cases`);
  const appointment = cases.find((value) => value.kind === "APPOINT")!;
  expect(preview.sort()).toEqual(appointment.items.map((item) => item.item_key).sort());
  const filings = appointment.items.filter((item) => item.kind === "FIL");
  expect(filings.length).toBeGreaterThan(0);
  const history = admin.getByRole("region", { name: "인사 이력", exact: true });
  await history.locator(`[id="ev-${appointment.trigger_id}"]`).getByRole("button", { name: title, exact: true }).click();
  const trail = admin.getByRole("dialog", { name: title, exact: true });
  for (const item of filings) {
    expect(item.filing_obligation_id).toBeTruthy();
    expect(item.due_disposition).toBe("UNKNOWN");
    expect(item.due_date).toBeNull();
    const row = trail.getByRole("listitem").filter({ has: admin.getByText(`${filingLabel(item.insurer!)} ${filingLabel(item.filing_kind!)}`, { exact: true }) });
    expect(item.blocks_close).toBe(released);
    await expect(row).toContainText("기한 미확인");
    if (released) {
      await expect(row.getByRole("link", { name: "신고 처리 기록", exact: true })).toBeVisible();
    } else {
      await expect(row).toContainText("법무 검토 전");
      await expect(row.getByRole("link", { name: "신고 처리 기록", exact: true })).toHaveCount(0);
    }
  }
  await audit(admin, "workplace appointment statutory trail");
  await trail.getByRole("button", { name: "닫기", exact: true }).last().click();
  for (const item of filings) {
    await go(admin, `/statutory?filing=${item.filing_obligation_id}`);
    if (released) {
      const dialog = admin.getByRole("dialog");
      await prepareFilingCompletion(admin, dialog);
      await fillDate(dialog, kstDate(), "신고일");
      await dialog.getByLabel(/^접수번호/).fill(`TRAIL-CHANGE-${item.insurer}`);
      await dialog.getByRole("button", { name: "미리보기", exact: true }).click();
      await dialog.getByRole("button", { name: "신고 완료", exact: true }).click();
      await expect(dialog).toBeHidden();
    } else {
      const row = admin.getByRole("row").filter({ has: admin.getByRole("cell", { name: `${filingLabel(item.insurer!)} · ${filingLabel(item.filing_kind!)}`, exact: true }) });
      await expect(row).toContainText("법무 검토 전");
      await expect(row.getByRole("button", { name: "처리 기록", exact: true })).toHaveCount(0);
      await expect(admin.getByRole("dialog")).toHaveCount(0);
    }
  }
  await audit(admin, "workplace appointment filing processing");
  const caseLink = admin.getByRole("link", { name: "사건 보기", exact: true });
  await expect(caseLink).toHaveAttribute("href", new RegExp(`case%3A${appointment.id}`));
  await caseLink.click();
  await routeReady(admin);
  const closing = admin.getByRole("dialog", { name: title, exact: true });
  if (released) {
    const updated = await read<Case>(`/api/v1/lifecycle-cases/${appointment.id}`);
    expect(updated.items.filter((item) => item.kind === "FIL").every((item) => item.status === "DONE_OBSERVED" && item.observed_ref?.table === "insurance_filing_records")).toBe(true);
    await expect(closing.getByRole("link", { name: "신고 접수 기록", exact: true })).toHaveCount(filings.length);
  }
  await closing.getByRole("listitem").filter({ has: admin.getByText("발령 서류 확인", { exact: true }) }).getByRole("button", { name: "증빙 확인 완료", exact: true }).click();
  const evidence = admin.getByRole("dialog", { name: "증빙 확인 완료", exact: true });
  await fillDate(evidence, kstDate(), "확인일");
  await evidence.getByLabel(/^증빙 이름/).fill("발령 서류 확인서");
  await evidence.getByLabel(/^증빙 링크/).fill("https://evidence.example/appointment.pdf");
  await chooseRadio(evidence, /^기타/);
  await evidence.getByLabel(/^확인 내용/).fill("발령 서류를 확인하고 처리를 마침");
  await evidence.getByRole("button", { name: "패스키로 확인하고 증빙 확인 완료", exact: true }).click();
  await expect(evidence).toBeHidden();
  await closing.getByRole("button", { name: "처리 종료", exact: true }).click();
  await expect(closing.getByRole("button", { name: "처리 종료", exact: true })).toHaveCount(0);
  expect((await read<Case>(`/api/v1/lifecycle-cases/${appointment.id}`)).state).toBe("CLOSED");
  } finally { restore?.(); }
});
}
