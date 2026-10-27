import { expect, test, type Page } from "@playwright/test";
import { fillDate } from "./sheet";
import { expectAccessible } from "./a11y";
import { go, kstDate, option } from "./flows";
import { reviseFact } from "./helpers/entity";
import { openTenant } from "./helpers/tenant";
import { pickKind, registerEntity, registerWorkplace, typeAddress, workplaceSheet } from "./setup-flows";

// 등록증 재발급·정정 (owner 2026-10-14, P0): 「there must be a way to upload a new 사업자등록증 … when we change the ceo, office」.
// From an empty tenant through the UI only. Red on the parent FE: no action anywhere took a new certificate with the facts it
// changed, and the first certificate entry could not reuse the original already attached to the 법인 (a second upload).

const PDF = (tag: string) => ({ name: `사업자등록증-${tag}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`) });
// Keep this fixture synthetic while using the corporation code and a matching check digit.
const REISSUE_ENTITY_IDS = { brn: "0008100009", crn: "0002110006241" };
const BUSAN = "부산광역시 해운대구 센텀중앙로 79";
const tabs = (a: Page) => a.getByRole("tablist", { name: "법인 정보 보기" });
const tab = (a: Page, name: string) => tabs(a).getByRole("tab", { name: new RegExp(`^${name}(?:\\s|$)`) });

test("a new 등록증 changing 대표자 and 소재지 is one dated change every surface shows; the old one stays", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "reissue", "새온그룹");
  await go(a, "/org/entities/new");
  await registerEntity(a, "새온정밀", false, undefined, REISSUE_ENTITY_IDS, PDF("v1"));
  const record = new URL(a.url()).pathname;
  await a.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(a, "새온정밀", "서울 본사");

  // Where the certificate is shown, the way in: the 법인 page's certificate card and the 사업장 panel's 등록증 row (which opens
  // the same sheet on the 법인 page).
  await go(a, record);
  // The 본점's certificate: its card is titled so once 서울 본사 holds it.
  const card = a.getByRole("region", { name: "사업자등록증 · 본점", exact: true });
  await expect(card.getByRole("button", { name: "000-81-00009 등록증 재발급·정정" })).toBeVisible();
  await tab(a, "사업장").click();
  await a.getByRole("row", { name: /서울 본사/ }).click();
  await a.getByRole("link", { name: "000-81-00009 등록증 재발급·정정" }).first().click();
  const sheet = a.getByRole("dialog", { name: "등록증 재발급·정정" });
  const save = sheet.getByRole("button", { name: "재발급·정정 기록" });
  const path = /\/api\/v1\/business-registrations\/[0-9a-f-]{36}\/reissues$/;
  let reissuePosts = 0;
  a.on("request", (request) => {
    if (request.method() === "POST" && path.test(new URL(request.url()).pathname)) reissuePosts++;
  });

  // UI guards: nothing records before the new certificate, the reason and what changed; each says what is missing.
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(sheet.getByText("새 등록증을 첨부하면 기록할 수 있습니다")).toBeVisible();
  await expectAccessible(a, "reissue sheet: empty");
  // The certificate in force dropped again is the same kept document: never recorded as the new one.
  await sheet.locator('input[type="file"]').setInputFiles(PDF("v1"));
  await expect(sheet.getByText("이미 보관된 등록증입니다. 새로 발급된 등록증을 첨부하십시오")).toBeVisible();
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await sheet.locator('input[type="file"]').setInputFiles(PDF("v2"));
  await expect(sheet.getByText("첨부함 · 사업자등록증-v2.pdf")).toBeVisible();
  await option(a, "발급 사유", "변경 · 정정신고로 다시 받음").click();
  await fillDate(sheet, kstDate(), "발급일");
  await expect(sheet.getByText("바뀐 항목을 하나 이상 선택하십시오")).toBeVisible();
  await expect(save).toHaveAttribute("aria-disabled", "true");
  // A change dated after today is refused where it is typed.
  await fillDate(sheet, kstDate(1), "적용일");
  await expect(sheet.getByText("오늘 이후 날짜는 기록할 수 없습니다.")).toBeVisible();
  await fillDate(sheet, kstDate(), "적용일");

  const facts = sheet.getByRole("group", { name: "바뀐 항목" });
  await facts.getByRole("button", { name: /^대표자/ }).click();
  await facts.getByRole("button", { name: /^사업장 소재지/ }).click();
  await expect(facts.getByRole("button", { pressed: true })).toHaveCount(2);
  await sheet.getByRole("button", { name: "홍길동 퇴임" }).click();
  await sheet.getByRole("button", { name: "대표자 선임" }).click();
  await sheet.getByLabel("새 대표자 1 이름").fill("김대표");
  await sheet.getByRole("group", { name: "사업장 소재지", exact: true }).getByRole("button", { name: "주소 다시 찾기" }).click();
  await typeAddress(a, "사업장 소재지", BUSAN, "48058");
  // Before saving, old → new for the certificate and every changed fact.
  const diff = sheet.getByRole("region", { name: "기록하면 바뀌는 내용" });
  await expect(diff).toContainText("사업자등록증-v1.pdf");
  await expect(diff).toContainText("사업자등록증-v2.pdf");
  await expect(diff).toContainText("홍길동");
  await expect(diff).toContainText("김대표");
  await expect(diff).toContainText(BUSAN);
  await expectAccessible(a, "reissue sheet: ready with old → new");

  // With every value ready, an amendment before the registered state is refused before it can send a command.
  const effectiveFrom = sheet.getByRole("textbox", { name: /^적용일/ });
  await effectiveFrom.fill("2020-03-01");
  await effectiveFrom.blur();
  await expect(sheet.getByText(/지금 등록증 내용은 .*부터입니다/)).toBeVisible();
  await expect(effectiveFrom).toHaveAttribute("aria-invalid", "true");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await save.dispatchEvent("click");
  await expect(effectiveFrom).toBeFocused();
  expect(reissuePosts, "an invalid earlier date sends no reissue").toBe(0);
  await effectiveFrom.fill(kstDate());
  await effectiveFrom.blur();

  // Negative: the server refuses (a body it cannot take); the words name it and nothing changed.
  await a.route(path, (r) => r.fallback({ postData: JSON.stringify({ ...r.request().postDataJSON(), effective_from: "2999-01-01" }) }));
  const refused = a.waitForResponse((r) => path.test(r.url()));
  await save.click();
  expect((await refused).status()).toBe(422);
  await expect(sheet.getByRole("alert")).toBeVisible();
  await expect(sheet.getByRole("alert")).not.toContainText("요청을 처리하지 못했습니다");
  await a.unroute(path);
  // Negative (the server's own guard, past the sheet's): a change dated before the certificate state in force would never
  // show while its certificate became the one in force; refused on the date, in words, nothing written.
  await a.route(path, (r) => r.fallback({ postData: JSON.stringify({ ...r.request().postDataJSON(), effective_from: "2000-01-03" }) }));
  const early = a.waitForResponse((r) => path.test(r.url()));
  await save.click();
  expect((await early).status()).toBe(422);
  await expect(sheet.getByRole("alert")).toContainText("지금 등록증 내용이 시작된 날보다 앞선 날짜입니다");
  await a.unroute(path);

  await save.click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  await tab(a, "개요").click();
  // Every surface derives from the one record: the card's ② and ⑤, the 임원 tab, the history and the documents.
  await expect(card).toContainText("김대표");
  await expect(card).toContainText(BUSAN);
  await expect(card).not.toContainText("홍길동");
  await tab(a, "임원").click();
  await expect(a.getByRole("main")).toContainText("김대표");
  await tab(a, "이력").click();
  const history = a.getByRole("region", { name: "등록증 · 000-81-00009" });
  await expect(history).toContainText("등록증 변경 (정정신고)");
  // One evidenced revision: the refused attempt wrote nothing.
  await expect(history.getByText("등록증 · 사업자등록증-v2.pdf")).toHaveCount(1);
  // Each issued certificate where it was recorded: the first one on the record's creation.
  await expect(history.getByText("등록증 · 사업자등록증-v1.pdf")).toHaveCount(1);
  await expectAccessible(a, "history with the certificate a revision was recorded from");
  await tab(a, "문서").click();
  const docs = a.getByRole("table", { name: "문서" });
  await expect(docs.getByRole("row", { name: /사업자등록증-v2\.pdf/ })).toContainText("사용 중");
  await expect(docs.getByRole("row", { name: /사업자등록증-v1\.pdf/ })).not.toContainText("사용 중");
});

test("a reissue cannot hide a scheduled 본점 move", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "reissue-scheduled", "새온그룹");
  await go(a, "/org/entities/new");
  await registerEntity(a, "새온정밀", false, undefined, REISSUE_ENTITY_IDS, PDF("v1"));
  const record = new URL(a.url()).pathname;
  await a.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(a, "새온정밀", "서울 본사");
  await go(a, record);

  const scheduled = kstDate(30);
  const move = await reviseFact(a, "본점 소재지", "rev", scheduled);
  await move.getByRole("group", { name: "본점 소재지", exact: true }).getByRole("button", { name: "주소 다시 찾기" }).click();
  await typeAddress(a, "본점 소재지", "대전광역시 유성구 대학로 99", "34134");
  await move.getByRole("button", { name: "변경 기록" }).click();
  await expect(move).toBeHidden();

  const card = a.getByRole("region", { name: "사업자등록증 · 본점", exact: true });
  await card.getByRole("button", { name: "000-81-00009 등록증 재발급·정정" }).click();
  const sheet = a.getByRole("dialog", { name: "등록증 재발급·정정" });
  const save = sheet.getByRole("button", { name: "재발급·정정 기록" });
  let reissuePosts = 0;
  const path = /\/api\/v1\/business-registrations\/[0-9a-f-]{36}\/reissues$/;
  a.on("request", (request) => {
    if (request.method() === "POST" && path.test(new URL(request.url()).pathname)) reissuePosts++;
  });

  await sheet.locator('input[type="file"]').setInputFiles(PDF("v2"));
  await option(a, "발급 사유", "변경 · 정정신고로 다시 받음").click();
  await fillDate(sheet, kstDate(), "발급일");
  const effectiveFrom = sheet.getByRole("textbox", { name: /^적용일/ });
  await effectiveFrom.fill(kstDate());
  await effectiveFrom.blur();
  const facts = sheet.getByRole("group", { name: "바뀐 항목" });
  await facts.getByRole("button", { name: /^대표자/ }).click();
  await sheet.getByRole("button", { name: "홍길동 퇴임" }).click();
  await sheet.getByRole("button", { name: "대표자 선임" }).click();
  await sheet.getByLabel("새 대표자 1 이름").fill("김대표");

  const errorId = (await effectiveFrom.getAttribute("aria-describedby"))?.split(/\s+/).find((id) => id.endsWith("-error"));
  expect(errorId, "the scheduled refusal is described by the effective date field").toBeDefined();
  await expect(sheet.locator(`[id="${errorId}"]`)).toContainText(/부터 적용되는 법인 변경이 예약돼 있어 대표자·법인명·본점은 이 적용일부터 함께 기록할 수 없습니다/);
  await expect(effectiveFrom).toHaveAttribute("aria-invalid", "true");
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await save.dispatchEvent("click");
  await expect(effectiveFrom).toBeFocused();
  expect(reissuePosts, "a scheduled entity state prevents the reissue command").toBe(0);
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "취소" }).click();
  await expect(sheet).toBeHidden();
  const history = a.getByRole("region", { name: "이력" });
  await expect(history.getByText(/예정/).first()).toBeVisible();
  await expect(history.getByText("등록증 변경 (정정신고)")).toHaveCount(0);
});

test("the first 등록증 entry reuses the original already attached to the 법인, never a second upload", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "reissue-first", "새온그룹");
  await go(a, "/org/entities/new");
  // The production shape: the original kept when the 법인 was created, no certificate recorded (its facts not typed yet).
  await option(a, "사업자 구분", "개인사업자").click();
  await a.getByLabel("상호").fill("새온공방");
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.locator('input[type="file"]').setInputFiles(PDF("kept"));
  await expect(a.getByText(PDF("kept").name)).toBeVisible();
  await a.getByRole("textbox", { name: /^대표자|^성명/ }).first().fill("박새온");
  await a.getByRole("button", { name: "다음", exact: true }).click();
  await a.getByRole("button", { name: "법인만 등록" }).click();
  await expect(a.getByRole("heading", { name: /새온공방/, level: 1 })).toBeVisible();
  const record = new URL(a.url()).pathname;
  await tab(a, "문서").click();
  await expect(a.getByRole("table", { name: "문서" }).getByRole("row", { name: /사업자등록증-kept\.pdf/ })).toBeVisible();
  await tab(a, "개요").click();

  // The first 사업장 with its own certificate: the kept original is offered first.
  await a.getByRole("link", { name: "사업장 추가" }).first().click();
  const sheet = workplaceSheet(a);
  await sheet.getByLabel("사업장 이름").fill("공방");
  await option(a, "사업자등록", "이 사업장의 등록증").click();
  const kept = sheet.getByRole("radiogroup", { name: /법인에 첨부된 등록증/ });
  await expect(kept).toContainText("사업자등록증-kept.pdf");
  await expectAccessible(a, "first certificate: the kept original offered");
  const uploads: string[] = [];
  a.on("request", (q) => q.method() === "POST" && /\/api\/v1\/entity-documents$/.test(q.url()) && uploads.push(q.url()));
  await kept.getByText(/^사업자등록증-kept\.pdf · /).click();
  await expect(kept.getByRole("radio", { checked: true })).toHaveCount(1);
  await sheet.getByLabel("사업자등록번호").fill("0001234560");
  await sheet.getByLabel("상호").fill("새온공방");
  await fillDate(sheet, "2021-05-03", "개업연월일");
  await typeAddress(a, "사업장 소재지", "서울특별시 마포구 월드컵북로 21", "03995");
  await sheet.getByRole("textbox", { name: /^업태/ }).fill("제조업");
  await sheet.getByRole("textbox", { name: /^종목/ }).fill("목공");
  await option(a, "사업자 단위 과세 적용", "적용 안 함").click();
  await sheet.getByLabel("과세유형").selectOption({ label: "일반과세자" });
  await sheet.getByLabel("관할 세무서 (등록증 표기)").fill("마포세무서");
  await option(a, "발급 사유", "신규").click();
  await fillDate(sheet, "2021-05-03", "발급일");
  await pickKind(sheet);
  await option(a, "원천징수 신고 사업장", "이 사업장에서 신고").click();
  await option(a, "이 사업장이 주된 사업장입니까", "주된 사업장").click();
  await option(a, "4대보험", "모두 성립 · 번호는 나중에").click();
  const add = sheet.getByRole("button", { name: "사업장 추가", exact: true });
  await expect(add).not.toHaveAttribute("aria-disabled", "true");
  await add.click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  expect(uploads, "no second upload of the kept original").toEqual([]);

  // One certificate on record, backed by the original kept at creation: one document, in use.
  await go(a, record);
  await tab(a, "문서").click();
  const rows = a.getByRole("table", { name: "문서" }).getByRole("row", { name: /사업자등록증/ });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("사용 중");
  await tab(a, "이력").click();
  await expect(a.getByRole("region", { name: "등록증 · 000-12-34560" }).getByText("등록증 · 사업자등록증-kept.pdf")).toHaveCount(1);
});

// ss-003-address-link (P0, filed 10-13): 「등록증과 같음」 stores a copy of the address, so the 사업장 holding the certificate keeps
// the old 소재지 after a reissue moves it. Lands with the link (no copy-propagation patch); the BE twin is
// entity_reissue_propagation_api::the_holder_workplace_shows_the_moved_address.
test.fixme("the 사업장 holding the certificate shows the 소재지 the reissue moved it to", { tag: ["@org", "@regression"] }, async ({ browser }) => {
  const a = await openTenant(browser, "reissue-panel", "새온그룹");
  await go(a, "/org/entities/new");
  await registerEntity(a, "새온정밀", false, undefined, REISSUE_ENTITY_IDS, PDF("v1"));
  const record = new URL(a.url()).pathname;
  await a.getByRole("link", { name: "사업장 추가" }).first().click();
  await registerWorkplace(a, "새온정밀", "서울 본사");
  await go(a, record);
  await tab(a, "사업장").click();
  await a.getByRole("row", { name: /서울 본사/ }).click();
  await a.getByRole("link", { name: "000-81-00009 등록증 재발급·정정" }).first().click();
  const sheet = a.getByRole("dialog", { name: "등록증 재발급·정정" });
  await sheet.locator('input[type="file"]').setInputFiles(PDF("v2"));
  await option(a, "발급 사유", "변경 · 정정신고로 다시 받음").click();
  await fillDate(sheet, kstDate(), "발급일");
  await sheet.getByRole("group", { name: "바뀐 항목" }).getByRole("button", { name: /^사업장 소재지/ }).click();
  await sheet.getByRole("group", { name: "사업장 소재지", exact: true }).getByRole("button", { name: "주소 다시 찾기" }).click();
  await typeAddress(a, "사업장 소재지", BUSAN, "48058");
  await sheet.getByRole("button", { name: "재발급·정정 기록" }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
  await go(a, record);
  await tab(a, "사업장").click();
  await a.getByRole("row", { name: /서울 본사/ }).click();
  await expect(a.getByRole("main").getByText(BUSAN).first()).toBeVisible();
});
