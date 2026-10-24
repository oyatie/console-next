import { expect, test, type Request } from "@playwright/test";
import { expectAccessible } from "./a11y";
import { go, koDate, kstDate, option, registerEmployee } from "./flows";
import { addDepts, openUnit, sheet } from "./helpers/structure";
import { openTenant } from "./helpers/tenant";
import { setupCompany, startOperations } from "./setup-flows";
import { box, findBox, leaveScreen, revealUnit } from "./structure-flows";

// One tenant, one signed-in ops account, no seeded records or API writes: dates and knowledge stay separate
// through corrections, scheduled entity facts and org changes. All fixtures are created with the product UI.
test("solo ops reads past and projected records, preserves known-at corrections and compares scheduled org changes", {
  tag: ["@org", "@first-run", "@regression", "@button-probe"],
}, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "ideal-asof", "시점상사");
  await setupCompany(admin, "시점상사", "본사");
  const record = new URL(admin.url()).pathname;
  const entityId = record.split("/").at(-1)!;
  const today = kstDate();
  const yesterday = kstDate(-1);
  const due = kstDate(3);
  const control = admin.getByRole("region", { name: "기준일", exact: true });
  const registry = admin.getByRole("region", { name: "등기 · 법인 기본" });

  // BL-024: capture the timestamp from the history read caused by saving the first correction.
  await admin.getByRole("button", { name: "대표전화 수정" }).click();
  const firstPhone = sheet(admin, "대표전화 수정");
  await option(admin, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  await firstPhone.getByRole("textbox", { name: /^대표전화/ }).fill("025550142");
  const firstHistory = admin.waitForResponse(async (r) => {
    if (r.request().method() !== "GET" || !r.ok()
      || new URL(r.url()).pathname !== `/api/v1/legal-entities/${entityId}/revisions`) return false;
    const body = await r.json() as { items: { reason_code?: string; changes: unknown }[] };
    return body.items.some((item) => item.reason_code === "CORRECTION"
      && JSON.stringify(item.changes).replace(/\D/g, "").includes("5550142"));
  });
  await firstPhone.getByRole("button", { name: "정정 기록" }).click();
  await expect(firstPhone).toBeHidden();
  const history = await (await firstHistory).json() as {
    items: { recorded_at: string; reason_code?: string; changes: unknown }[];
  };
  const firstCorrection = history.items.find((r) => r.reason_code === "CORRECTION"
    && JSON.stringify(r.changes).replace(/\D/g, "").includes("5550142"));
  expect(firstCorrection, "the UI's revision read includes the first phone correction").toBeDefined();
  const known = firstCorrection!.recorded_at;
  expect(known).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(registry).toContainText("02-555-0142");

  await admin.getByRole("button", { name: "대표전화 수정" }).click();
  const secondPhone = sheet(admin, "대표전화 수정");
  await option(admin, "무엇을 기록합니까", "처음부터 잘못 적었습니다 · 정정").click();
  await secondPhone.getByRole("textbox", { name: /^대표전화/ }).fill("025550143");
  await secondPhone.getByRole("button", { name: "정정 기록" }).click();
  await expect(secondPhone).toBeHidden();
  await expect(registry).toContainText("02-555-0143");
  await go(admin, `${record}?as_of=${today}&known_at=${encodeURIComponent(known)}`);
  await expect(control).toContainText("에 알려진 대로");
  await expect(registry).toContainText("02-555-0142");
  await expect(registry).not.toContainText("02-555-0143");
  await expect(admin.getByRole("button", { name: /수정|정정$|법인 종료|법인 삭제/ })).toHaveCount(0);
  await control.getByRole("button", { name: "오늘로" }).focus();
  await admin.keyboard.press("Enter");
  await expect(registry).toContainText("02-555-0143");

  // Server refusal: an invalid deep link keeps its visible date remedy and cannot write any record.
  const writes: string[] = [];
  const observeWrites = (r: Request) => {
    if (!["GET", "HEAD"].includes(r.method()) && /\/api\/v1\/(legal-entities|workplaces|business-registrations)\//.test(new URL(r.url()).pathname)) writes.push(r.url());
  };
  admin.on("request", observeWrites);
  const invalidKnown = `${today}Tgarbage`;
  const invalidRead = admin.waitForResponse((r) => r.request().method() === "GET"
    && new URL(r.url()).pathname === `/api/v1/legal-entities/${entityId}`
    && new URL(r.url()).searchParams.get("known_at") === invalidKnown);
  await go(admin, `${record}?as_of=${today}&known_at=${invalidKnown}`);
  const refused = await invalidRead;
  expect(refused.status()).toBe(422);
  expect(await refused.json()).toMatchObject({
    error: { code: "validation_failed", errors: [{ field: "known_at", code: "date_invalid" }] },
  });
  await expect(control).toContainText("올바른 날짜를 선택하십시오");
  await expect(control.getByRole("button", { name: "오늘로" })).toBeVisible();
  await expect(admin.getByRole("button", { name: /수정|정정$|법인 종료|법인 삭제/ })).toHaveCount(0);
  await control.getByRole("button", { name: "오늘로" }).click();
  await expect(registry).toContainText("02-555-0143");
  await expect(registry).not.toContainText("02-555-0142");
  expect(writes).toEqual([]);
  admin.off("request", observeWrites);

  // BL-023: the future legal name is selected by effective date; today's and yesterday's remain intact.
  await admin.getByRole("button", { name: "법인명(단체명) 수정" }).click();
  const name = sheet(admin, "법인명(단체명) 수정");
  await option(admin, "무엇을 기록합니까", "법인명이 바뀌었습니다 · 변경").click();
  await option(admin, "언제부터 바뀝니까", "직접 입력").click();
  await name.getByLabel(/^적용일/).fill(due);
  await name.getByRole("textbox", { name: /^법인명\(단체명\)/ }).fill("주식회사 미래상사");
  await name.getByRole("button", { name: "변경 기록" }).click();
  await expect(name).toBeHidden();
  await expect(admin.getByRole("heading", { name: "주식회사 시점상사", level: 1 })).toBeVisible();
  await control.getByLabel(/^기준일/).fill(due);
  await control.getByLabel(/^기준일/).blur();
  await expect(admin.getByRole("heading", { name: "주식회사 미래상사", level: 1 })).toBeVisible();
  await expect(control).toContainText(`${koDate(due)} 기준 · 예정`);
  await expect(admin.getByRole("button", { name: /수정/ })).toHaveCount(0);
  await control.getByLabel(/^기준일/).fill(yesterday);
  await control.getByLabel(/^기준일/).blur();
  await expect(admin.getByRole("heading", { name: "주식회사 시점상사", level: 1 })).toBeVisible();
  await expect(control).toContainText("그날 등록증 기준");
  await expect(control).not.toContainText("읽기 전용");
  await expect(admin.getByRole("button", { name: /수정|정정$|법인 종료|법인 삭제/ })).toHaveCount(0);
  await expect(admin.getByRole("link", { name: "사업장 추가", exact: true })).toHaveCount(0);
  // A historical workplace row carries the coordinate into its panel, where write verbs remain absent.
  await admin.getByRole("row", { name: /본사/ }).click();
  await expect(admin).toHaveURL(new RegExp(`as_of=${yesterday}`));
  const workplace = admin.getByRole("complementary", { name: "본사", exact: true });
  await expect(workplace).toBeVisible();
  await expect(workplace.getByRole("button", { name: /수정|더보기|추가|휴업|재개/ })).toHaveCount(0);
  await leaveScreen(admin);
  await expectAccessible(admin, "as-of: historical legal entity and workplace, light and dark");
  await control.getByRole("button", { name: "오늘로" }).click();
  await go(admin, `/org/entities?as_of=${yesterday}&add=true`);
  await expect(admin.getByRole("row", { name: /시점상사/ })).toBeVisible();
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  await expect(admin.getByRole("link", { name: "법인 추가", exact: true })).toHaveCount(0);

  await addDepts(admin, "본사", ["영업팀", "종료팀"]);
  await registerEmployee(admin, { name: "김영업", unit: "영업팀", hired: kstDate(-30) });
  await registerEmployee(admin, { name: "김종료", unit: "종료팀", hired: kstDate(-30) });
  await startOperations(admin);
  await go(admin, "/org");

  // Scheduled rename and creation share a future change-date marker, while today's tree stays unchanged.
  const sales = await openUnit(admin, "영업팀");
  await sales.getByRole("button", { name: "이름 변경" }).click();
  const rename = sheet(admin, "영업팀 이름 변경");
  await rename.getByRole("textbox", { name: /^새 이름/ }).fill("국내영업팀");
  await rename.getByRole("textbox", { name: /^시행일/ }).fill(due);
  await rename.getByRole("textbox", { name: /^사유/ }).fill("영업 조직 이름 정리");
  await rename.getByRole("button", { name: "부서 이름 변경 1개 예약" }).click();
  const receipt = admin.getByRole("status").filter({
    has: admin.getByRole("link", { name: /^OC-\d{4}-\d{4} 기록 보기$/ }),
  });
  await expect(receipt).toContainText("영업팀 → 국내영업팀");
  const renameCode = (await receipt.getByRole("link", { name: /기록 보기$/ }).innerText()).match(/OC-\d{4}-\d{4}/)![0];
  await revealUnit(admin, "본사");
  await admin.keyboard.press("a");
  const create = sheet(admin, "부서 신설");
  await create.getByLabel("부서 이름").fill("미래팀");
  await create.getByRole("textbox", { name: /^시행일/ }).fill(due);
  await create.getByLabel("사유").fill("미래 사업 준비");
  await create.getByRole("button", { name: "부서 신설 1개 예약" }).click();
  await expect(receipt).toContainText("미래팀 신설");
  const createCode = (await receipt.getByRole("link", { name: /기록 보기$/ }).innerText()).match(/OC-\d{4}-\d{4}/)![0];
  const ending = await openUnit(admin, "종료팀");
  await ending.getByRole("button", { name: "부서 폐지", exact: true }).click();
  const dissolve = sheet(admin, "종료팀 폐지");
  await dissolve.getByRole("textbox", { name: /^시행일/ }).fill(due);
  await dissolve.getByLabel("사유").fill("한시 조직 종료");
  await dissolve.getByRole("button", { name: "부서 폐지 1개 예약" }).click();
  await expect(receipt).toContainText("종료팀 폐지");
  const dissolveCode = (await receipt.getByRole("link", { name: /기록 보기$/ }).innerText()).match(/OC-\d{4}-\d{4}/)![0];
  await findBox(admin, "종료팀"); // before its dissolution date, the dated read retains the unit
  await findBox(admin, "영업팀");
  await expect(box(admin, "국내영업팀")).toHaveCount(0);
  await expect(box(admin, "미래팀")).toHaveCount(0);
  await expect(control.getByRole("group", { name: "변경일" }).locator(`[data-change-date="${due}"]`)).toBeVisible();

  // Keyboard-only date walk: next change → future, previous change → today, knowledge toggle → clear.
  await control.getByRole("button", { name: "다음 변경일" }).focus();
  await admin.keyboard.press("Enter");
  await expect(control.getByLabel(/^기준일/)).toHaveValue(koDate(due));
  await expect(box(admin, "종료팀")).toHaveCount(0);
  await findBox(admin, "국내영업팀");
  await expect(box(admin, "국내영업팀")).toHaveAttribute("data-scheduled", "true");
  await expect(box(admin, "국내영업팀")).toHaveAttribute("data-s", /\bscheduled\b/);
  await expect(box(admin, "국내영업팀")).toHaveAttribute("aria-label", /1명/);
  await expect(box(admin, "국내영업팀")).toHaveCSS("border-top-style", "dashed");
  await findBox(admin, "본사");
  await expect(box(admin, "본사")).toHaveAttribute("aria-label", /2명/); // dissolution moves its member to the parent

  await expect(box(admin, "영업팀")).toHaveCount(0);
  await findBox(admin, "미래팀");
  await expect(box(admin, "미래팀")).toHaveAttribute("data-scheduled", "true");
  await expect(box(admin, "미래팀")).toHaveAttribute("data-s", /\bscheduled\b/);
  await expect(box(admin, "미래팀")).toHaveCSS("border-top-style", "dashed");
  await expect(admin.getByRole("button", { name: "이 날짜로 조직 변경 작성" })).toBeVisible();
  await revealUnit(admin, "본사");
  const draftWrites: string[] = [];
  const observeDraftWrites = (r: Request) => {
    if (!["GET", "HEAD"].includes(r.method()) && new URL(r.url()).pathname.startsWith("/api/v1/org-changes")) draftWrites.push(r.url());
  };
  admin.on("request", observeDraftWrites);
  await admin.getByRole("button", { name: "이 날짜로 조직 변경 작성" }).click();
  const proposal = admin.getByRole("dialog", { name: "본사 아래에 부서 신설", exact: true });
  await expect(proposal).toBeVisible();
  await expect(proposal.getByRole("term").filter({ hasText: "상위 조직" }).locator("xpath=following-sibling::dd[1]")).toContainText("본사");
  await expect(proposal.getByRole("textbox", { name: /^시행일/ })).toHaveValue(koDate(due));
  await proposal.getByRole("button", { name: "닫기", exact: true }).last().click();
  await expect(proposal).toHaveCount(0);
  expect(draftWrites).toEqual([]);
  admin.off("request", observeDraftWrites);
  await expect(control.getByLabel(/^기준일/)).toHaveValue(koDate(due));
  await revealUnit(admin, "본사");
  await admin.keyboard.press("a");
  await expect(admin.getByRole("dialog")).toHaveCount(0);
  await expect(admin.getByRole("complementary", { name: "조직 변경 작성", exact: true })).toHaveCount(0);

  // Focusable refusals name visible reasons; pressing an unavailable arrow cannot navigate.
  const unavailable = control.locator('button[aria-disabled="true"]');
  expect(await unavailable.count()).toBeGreaterThan(0);
  for (const button of await unavailable.all()) {
    await expect(button).not.toHaveAttribute("disabled");
    const reasons = (await button.getAttribute("aria-describedby"))!.split(/\s+/);
    for (const id of reasons) await expect(admin.locator(`[id="${id}"]`)).toBeVisible();
  }
  const unchanged = admin.url();
  await control.getByRole("button", { name: "다음 변경일" }).focus();
  await admin.keyboard.press("Space");
  await expect(admin).toHaveURL(unchanged);
  await admin.getByRole("button", { name: "내보내기", exact: true }).click();
  const exporting = sheet(admin, "조직도 내보내기");
  const preview = await exporting.getByRole("img").getAttribute("src");
  expect(preview).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  const exported = decodeURIComponent(preview!.slice(preview!.indexOf(",") + 1));
  expect(exported).toContain(`${due} 기준`);
  expect(exported).not.toContain("에 알려진 대로");
  await exporting.getByRole("button", { name: "취소", exact: true }).click();
  await control.getByRole("button", { name: "이전 변경일" }).focus();
  await admin.keyboard.press("Enter");
  await expect(control.getByLabel(/^기준일/)).toHaveValue(koDate(today));
  await control.getByRole("button", { name: "알려진 시점 선택" }).focus();
  await admin.keyboard.press("Space");
  await expect(control.getByLabel(/^알려진 시점/)).toBeVisible();
  await admin.keyboard.press("Space");
  await expect(control.getByLabel(/^알려진 시점/)).toHaveCount(0);

  // The same date control follows chart, list and outline. A past deep link cannot open a write sheet.
  await control.getByLabel(/^기준일/).fill(yesterday);
  await control.getByLabel(/^기준일/).blur();
  await expect(control).toContainText(`${koDate(yesterday)} 기준 · 과거`);
  await expect(admin.getByRole("button", { name: "가져오기", exact: true })).toHaveCount(0);
  await admin.getByRole("group", { name: "보기", exact: true }).getByRole("button", { name: "목록", exact: true }).click();
  await expect(control.getByLabel(/^기준일/)).toHaveValue(koDate(yesterday));
  await expect(admin.getByRole("button", { name: /위로|아래로|부서장 지정|함께 수정/ })).toHaveCount(0);
  await admin.getByRole("group", { name: "보기", exact: true }).getByRole("button", { name: "아웃라인", exact: true }).click();
  await expect(control.getByLabel(/^기준일/)).toHaveValue(koDate(yesterday));
  await expect(admin.getByRole("button", { name: "목록 붙여넣기" })).toHaveCount(0);
  await expect(admin.getByRole("textbox", { name: /새 부서|이름/ })).toHaveCount(0);
  await control.getByRole("button", { name: "오늘", exact: true }).focus();
  await admin.keyboard.press("Enter");
  await admin.getByRole("group", { name: "보기", exact: true }).getByRole("button", { name: "조직도", exact: true }).click();
  await findBox(admin, "영업팀");

  // BL-025: compare today to the approved future projection, preserving both marks and change-set links.
  const compare = admin.getByRole("region", { name: "기준일 비교", exact: true });
  const results = admin.getByRole("region", { name: "이 기간의 조직 변경", exact: true });
  await compare.getByRole("button", { name: "기준일 비교", exact: true }).click();
  await compare.getByLabel(/^날짜 A/).fill(today);
  await compare.getByLabel(/^날짜 A/).blur();
  await compare.getByLabel(/^날짜 B/).fill(due);
  await compare.getByLabel(/^날짜 B/).blur();
  await findBox(admin, "국내영업팀");
  await expect(box(admin, "국내영업팀")).toHaveAttribute("data-diff", /\brenamed\b/);
  await findBox(admin, "미래팀");
  await expect(box(admin, "미래팀")).toHaveAttribute("data-diff", /\bnew\b/);
  await findBox(admin, "종료팀");
  await expect(box(admin, "종료팀")).toHaveAttribute("data-diff", /\bgone\b/);
  await expect(box(admin, "종료팀")).toHaveAttribute("aria-label", /0명/);
  await expect(results.getByRole("link", { name: dissolveCode, exact: true }).first()).toHaveAttribute("href", /\/org\/changes\/[0-9a-f-]+/);
  await expect(results).toContainText("영업팀 → 국내영업팀");
  await expect(results.getByRole("link", { name: renameCode, exact: true }).first()).toHaveAttribute("href", /\/org\/changes\/[0-9a-f-]+/);
  await expect(results.getByRole("link", { name: createCode, exact: true }).first()).toHaveAttribute("href", /\/org\/changes\/[0-9a-f-]+/);
  await expect(results.getByRole("link", { name: "이 기간의 조직 변경", exact: true })).toHaveAttribute("href", new RegExp(`effective_from=${today}.*effective_to=${due}`));

  // Local malformed/reversed inputs refuse with a remedy, issue no read and keep the last committed tree.
  const requests: string[] = [];
  const observe = (r: Request) => {
    if (new URL(r.url()).pathname === "/api/v1/org-structure/diff") requests.push(r.url());
  };
  admin.on("request", observe);
  const committed = admin.url();
  await compare.getByLabel(/^날짜 B/).fill("");
  await compare.getByLabel(/^날짜 B/).blur();
  await expect(compare).toContainText("올바른 날짜를 선택하십시오");
  await expect(compare.getByRole("button", { name: "날짜 B 선택" })).toBeVisible();
  await expect(admin).toHaveURL(committed);
  await expect(box(admin, "미래팀")).toHaveAttribute("data-diff", /\bnew\b/);
  await compare.getByLabel(/^날짜 B/).fill(yesterday);
  await compare.getByLabel(/^날짜 B/).blur();
  await expect(compare).toContainText("날짜 B는 날짜 A와 같거나 이후여야 합니다");
  await expect(admin).toHaveURL(committed);
  await expect(box(admin, "국내영업팀")).toHaveAttribute("data-diff", /\brenamed\b/);
  expect(requests).toEqual([]);
  admin.off("request", observe);
  await leaveScreen(admin);
  await expectAccessible(admin, "as-of: projected compare with invalid-date remedy, light and dark");
  await compare.getByRole("button", { name: "날짜 B 선택" }).focus();
  await admin.keyboard.press("Enter");
  await expect(compare.getByLabel(/^날짜 B/)).toHaveValue(koDate(today));
  await expect(results).toContainText("두 날짜 사이에 조직 구조가 바뀌지 않았습니다");
  await expect(box(admin, "미래팀")).toHaveCount(0);
  await findBox(admin, "영업팀");
});
