import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { pick } from "../emp/steps";
import { go } from "../flows";
import { reasonChip } from "../helpers/lifecycle";
import { andReread, openCard, soloWorld } from "./world";

// The 인사카드 under the record-actions pattern (docs/design/record-actions.md): every backend-served section reachable and
// editable from the card, each row's 수정 editing that row, ⋯ holding its history and end verb, and the path said before
// each commit. Once in the setup phase (삭제 offered) and once after 운영 시작 (the same 수정 is recorded as a correction;
// no hard delete is offered).

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function addContact(admin: Page, name: string, relation: string, phone: string) {
  await admin.getByRole("button", { name: "비상연락처 추가" }).click();
  const sheet = admin.getByRole("dialog", { name: "비상연락처 추가" });
  await sheet.getByRole("textbox", { name: /^이름/ }).fill(name);
  await sheet.getByRole("combobox", { name: /^관계/ }).selectOption({ label: relation });
  await sheet.getByRole("textbox", { name: /^휴대전화/ }).fill(phone);
  return sheet;
}

/** The card's own read of the employee (its version) and its correction PATCH. */
const DETAIL = /\/api\/v1\/employees\/[0-9a-f-]{36}(\?.*)?$/;

/**
 * Holds the card's re-read of the employee (its DETAIL GET, so the card keeps showing the version read before) until the
 * returned release is called, or 30 s. Pins the race of a command pressed before the user's own earlier write re-read.
 */
async function holdCardRead(admin: Page) {
  let release = () => {};
  const held = new Promise<void>((done) => (release = done));
  await admin.route(DETAIL, async (r) => {
    if (r.request().method() === "GET") await Promise.race([held, new Promise((done) => setTimeout(done, 30_000))]);
    await r.fallback().catch(() => undefined); // a read the page dropped meanwhile
  });
  return async () => (release(), admin.unroute(DETAIL));
}

/**
 * Adds a career, then edits it with a why: the why reaches the server as the correction's reason code. The card's read of
 * the employee is held throughout (regression: 경력 수정 409 against the user's own 경력 추가): the edit is sent at the
 * version of the read that drew the rows, never refused against the add it was made on.
 */
async function careerWithWhy(admin: Page, records: Locator, from: string, to: string) {
  const release = await holdCardRead(admin);
  await records.getByRole("button", { name: "경력 추가" }).click();
  const add = admin.getByRole("group", { name: "새 경력 줄" });
  await add.getByRole("textbox", { name: "근무처" }).fill(from);
  await add.getByLabel("시작일").fill("2019-01");
  await andReread(admin, "/register-facts", () => add.getByRole("button", { name: "저장" }).click());
  await expect(records.getByRole("row").filter({ hasText: from })).toBeVisible();
  await add.getByRole("button", { name: "닫기" }).click();
  await records.getByRole("button", { name: `${from} 2019-01 수정` }).click();
  const fix = admin.getByRole("group", { name: "경력 줄 수정" });
  await fix.getByRole("textbox", { name: "근무처" }).fill(to);
  await fix.getByRole("combobox", { name: /왜 정정합니까/ }).selectOption({ label: "원본 서류와 다름" });
  // The body is read where the request leaves (Chromium keeps no body on a request nothing routed).
  let body: unknown;
  await admin.route(DETAIL, async (r) => {
    if (r.request().method() === "PATCH") body = r.request().postDataJSON();
    await r.fallback().catch(() => undefined);
  });
  const sent = admin.waitForResponse((r) => r.request().method() === "PATCH" && DETAIL.test(r.url()));
  await fix.getByRole("button", { name: "정정 기록" }).click();
  const res = await sent;
  await release();
  expect(res.status(), "the edit is not refused against the user's own add").toBe(200);
  expect(body).toMatchObject({ reason_code: "SOURCE_MISMATCH", changes: { careers: [expect.objectContaining({ employer_name: to })] } });
  await expect(fix).toBeHidden();
  await expect(records.getByRole("row").filter({ hasText: to })).toBeVisible();
}

test("setup phase: contacts, photo, entries and careers are added, edited, traced and deleted from the card", { tag: "@record-actions" }, async ({ browser }) => {
  const w = await soloWorld(browser, "ra-card", "가람상사", false);
  const { admin } = w;
  const personal = await openCard(w);

  // 비상연락처: 추가 says the setup path before the commit, then the row has its own 수정 and ⋯.
  const sheet = await addContact(admin, "홍길순", "배우자", "01022223333");
  await expect(sheet.getByText("바로 반영 (설정 단계)")).toBeVisible();
  await expectAccessible(admin, "emergency contact sheet");
  await sheet.getByRole("button", { name: "인사 정보 1명 정정" }).click();
  await expect(sheet).toBeHidden();
  await expect(personal.getByText("배우자 홍••")).toBeVisible();
  await personal.getByRole("button", { name: "비상연락처 배우자 홍•• 수정" }).click();
  const edit = admin.getByRole("dialog", { name: "비상연락처 수정" });
  await expect(edit.getByRole("textbox", { name: /^이름/ })).toHaveValue("홍길순");
  await edit.getByRole("combobox", { name: /^관계/ }).selectOption({ label: "형제자매" });
  await edit.getByRole("button", { name: "인사 정보 1명 정정" }).click();
  await expect(personal.getByText("형제자매 홍••")).toBeVisible();
  // Regression (photo 409 against the user's own write): the card's re-read is held until the photo is recorded, so 사진 추가
  // is pressed and sent at the version read before this delete; it still saves (the delete touched another field), never
  // 「someone changed it」.
  const release = await holdCardRead(admin);
  await personal.getByRole("button", { name: "비상연락처 형제자매 홍•• 더보기" }).click();
  await andReread(admin, "/personal-facts", () => admin.getByRole("menuitem", { name: "삭제" }).click());
  await expect(personal.getByText("형제자매 홍••")).toBeHidden();

  // 사진: added (presigned upload, confirm, record), then shown in the head and the row.
  await personal.getByRole("button", { name: "사진 추가" }).click();
  const photo = admin.getByRole("dialog", { name: "사진 추가" });
  await photo.locator('input[type="file"]').setInputFiles({ name: "face.png", mimeType: "image/png", buffer: PNG });
  await expect(photo.getByRole("img", { name: "올릴 사진 face.png" })).toBeVisible();
  const recorded = admin.waitForResponse((r) => r.request().method() === "PATCH" && DETAIL.test(r.url()));
  await photo.getByRole("button", { name: "사진 추가" }).click();
  expect((await recorded).status(), "the photo is recorded, not refused against the delete").toBe(200);
  await release();
  await expect(photo).toBeHidden();
  await expect(admin.locator(`img[alt="${w.person} 사진"]`).first()).toBeVisible();
  await expect(personal.getByRole("button", { name: "사진 수정" })).toBeVisible();

  // Regression (사번 변경 409 against the user's own write): every writer of the record goes past this tab's own writes
  // (lib/record-versions), so 사번 변경 pressed while the card still shows the version before the delete is changed.
  const again = await addContact(admin, "홍길순", "배우자", "01022223333");
  await andReread(admin, "/personal-facts", () => again.getByRole("button", { name: "인사 정보 1명 정정" }).click());
  await expect(personal.getByText("배우자 홍••")).toBeVisible();
  const free = await holdCardRead(admin);
  await personal.getByRole("button", { name: "비상연락처 배우자 홍•• 더보기" }).click();
  await andReread(admin, "/personal-facts", () => admin.getByRole("menuitem", { name: "삭제" }).click());
  await expect(personal.getByText("배우자 홍••")).toBeHidden();
  await admin.getByRole("button", { name: "사번 변경", exact: true }).click();
  const empno = admin.getByRole("dialog", { name: "사번 변경" });
  const currentNumber = (await empno.innerText()).match(/지금 ([^ ]+)/)?.[1];
  expect(currentNumber).toBeTruthy();
  const newNumber = currentNumber === "90417" ? "90418" : "90417";
  expect(newNumber).not.toBe(currentNumber);
  await empno.getByRole("textbox", { name: "새 사번" }).fill(newNumber);
  await pick(empno, /언제부터/, "오늘부터").click();
  await reasonChip(empno, "사번 체계 변경", "사유").click();
  const numbered = admin.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/employee-number"));
  await empno.getByRole("button", { name: "사번 1명 변경", exact: true }).click();
  expect((await numbered).status(), "the number is changed, not refused against the delete").toBe(200);
  await free();
  await expect(empno).toBeHidden();

  // 이력 › 학력: added, corrected with why (the next version), its history shows both versions, then voided.
  const records = admin.getByRole("region", { name: "이력" });
  await records.getByRole("button", { name: "학력 추가" }).click();
  const row = admin.getByRole("group", { name: "새 학력 줄" });
  await row.getByRole("textbox", { name: "학교" }).fill("한빛고등학교");
  await row.getByRole("combobox", { name: "과정" }).selectOption("HIGH_SCHOOL");
  await row.getByRole("combobox", { name: "상태" }).selectOption("GRADUATED");
  await row.getByRole("button", { name: "저장" }).click();
  await expect(records.getByText("한빛고등학교")).toBeVisible();
  await row.getByRole("button", { name: "닫기" }).click();
  await records.getByRole("button", { name: "한빛고등학교 수정" }).click();
  const fix = admin.getByRole("group", { name: "학력 줄 수정" });
  await expect(fix.getByRole("textbox", { name: "학교" })).toHaveValue("한빛고등학교");
  await fix.getByRole("textbox", { name: "학교" }).fill("한빛여자고등학교");
  await fix.getByRole("button", { name: "정정 기록" }).click();
  await expect(fix.getByRole("status")).toContainText("왜 정정합니까");
  await fix.getByRole("combobox", { name: /왜 정정합니까/ }).selectOption({ label: "입력 실수" });
  await fix.getByRole("button", { name: "정정 기록" }).click();
  await expect(fix).toBeHidden();
  await expect(records.getByText("한빛여자고등학교")).toBeVisible();
  await records.getByRole("button", { name: "한빛여자고등학교 더보기" }).click();
  await admin.getByRole("menuitem", { name: "이력" }).click();
  const history = admin.getByRole("dialog", { name: "한빛여자고등학교 이력" });
  await expect(history.getByRole("row").filter({ hasText: "처음 기록" })).toContainText("한빛고등학교");
  await expect(history.getByRole("row").filter({ hasText: "정정" })).toContainText("입력 실수");
  await expectAccessible(admin, "record entry history");
  await history.getByRole("button", { name: "닫기" }).first().click();

  // 경력 (register item 5): added, edited in place, deleted in the setup phase. The delete is pressed while the card's read of
  // the employee is held (regression: refused 409 against the user's own add); it goes at the version that drew the rows.
  const held = await holdCardRead(admin);
  await records.getByRole("button", { name: "경력 추가" }).click();
  const career = admin.getByRole("group", { name: "새 경력 줄" });
  await career.getByRole("textbox", { name: "근무처" }).fill("다올기계");
  await career.getByLabel("시작일").fill("2019-01");
  await andReread(admin, "/register-facts", () => career.getByRole("button", { name: "저장" }).click());
  await expect(records.getByRole("row").filter({ hasText: "다올기계" })).toBeVisible();
  await career.getByRole("button", { name: "닫기" }).click();
  await records.getByRole("button", { name: /^다올기계 .* 더보기$/ }).click();
  const deleted = admin.waitForResponse((r) => r.request().method() === "PATCH" && DETAIL.test(r.url()));
  await admin.getByRole("menuitem", { name: "삭제" }).click();
  expect((await deleted).status(), "the delete is not refused against the user's own add").toBe(200);
  await held();
  await expect(records.getByRole("row").filter({ hasText: "다올기계" })).toHaveCount(0);
  await careerWithWhy(admin, records, "한결정밀", "한결정밀공업");

  // ⌘K: the record's actions are in the palette; 비상연락처 추가 opens its sheet on the card.
  await admin.keyboard.press("ControlOrMeta+k");
  await admin.getByRole("searchbox", { name: "찾기와 이동" }).fill(w.person);
  await admin.getByRole("option", { name: "비상연락처 추가" }).click();
  await expect(admin.getByRole("dialog", { name: "비상연락처 추가" })).toBeVisible();
  await admin.getByRole("dialog", { name: "비상연락처 추가" }).getByRole("button", { name: "닫기", exact: true }).last().click();
  await expect(admin.getByRole("dialog", { name: "비상연락처 추가" })).toBeHidden();

  // 주민등록번호: the honest state, no dead control; 문서: no upload button the server cannot take.
  await expect(personal.getByText(/번호 입력·정정은 승인 절차/)).toBeVisible();
  await expect(admin.getByRole("region", { name: "문서" }).getByRole("button")).toHaveCount(0);
  await expectAccessible(admin, "personnel card, record actions");
});

test("after 운영 시작: the same 수정 is recorded as a correction and no hard delete is offered", { tag: "@record-actions" }, async ({ browser }) => {
  const w = await soloWorld(browser, "ra-live", "나래상사", true);
  const { admin } = w;
  const personal = await openCard(w);
  const sheet = await addContact(admin, "박하늘", "부모", "01044445555");
  await expect(sheet.getByText("정정 기록으로 남습니다")).toBeVisible();
  await expect(sheet.getByText("설정 단계")).toHaveCount(0);
  await sheet.getByRole("button", { name: "인사 정보 1명 정정" }).click();
  await expect(personal.getByText("부모 박••")).toBeVisible();
  await personal.getByRole("button", { name: "비상연락처 부모 박•• 더보기" }).click();
  await expect(admin.getByRole("menuitem", { name: "삭제" })).toHaveCount(0);
  await admin.getByRole("menuitem", { name: "무효화" }).click();
  await expect(personal.getByText("부모 박••")).toBeHidden();

  // A stale write (someone saved this person first, here a second tab) is refused with 409 and said in the sheet; nothing changes.
  await addContact(admin, "이바다", "자녀", "01066667777");
  const other = await admin.context().newPage();
  await go(other, `/people/${w.personId}`);
  await other.getByRole("button", { name: "국적 · 신분증 수정" }).click();
  await other.getByRole("textbox", { name: "국적 · 신분증" }).fill("KR");
  const saved = other.waitForResponse((r) => r.request().method() === "PATCH" && DETAIL.test(r.url()));
  await other.getByRole("textbox", { name: "국적 · 신분증" }).press("Enter");
  expect((await saved).status()).toBe(200);
  await expect(other.getByText(/국적 · 신분증.*저장했습니다/)).toBeVisible();
  const stale = admin.getByRole("dialog", { name: "비상연락처 추가" });
  // The refusal re-reads the record (lib/react/command readsAreStale); the next write waits for that read to land, as a
  // person reading the notice would. A write pressed before it lands is refused too (whole-record precondition until
  // unit me6-employee-field-preconditions). The career below is written at the register facts' version, so their re-read too.
  const facts = admin.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname.endsWith("/register-facts"));
  await andReread(admin, `/employees/${w.personId}`, () => stale.getByRole("button", { name: "인사 정보 1명 정정" }).click());
  await facts;
  await expect(stale.getByRole("alert")).toBeVisible();
  await expect(stale).toBeVisible();
  await expect(personal.getByText("자녀 이••")).toHaveCount(0);
  await other.close();
  await stale.getByRole("button", { name: "닫기", exact: true }).last().click();

  // 경력 수정 after 운영 시작: the why asked is the correction's reason on the server, as in the setup phase.
  await careerWithWhy(admin, admin.getByRole("region", { name: "이력" }), "누리정밀", "누리정밀공업");
});
