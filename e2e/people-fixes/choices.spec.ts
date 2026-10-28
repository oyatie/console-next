import { commitLabel } from "../../apps/web/src/ui/composer/actions";
import { loadCatalog } from "@console/i18n";
import { expect, test } from "@playwright/test";
import { expectAccessible } from "../a11y";
import { go, kstDate } from "../flows";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { peopleWorld, pickBulk, registerAt } from "../helpers/people-fixes";
import { addTitle } from "../helpers/titles";
import { hrAct, openHistory } from "../record";
import { fillDate, reasonBox, sheet, todayPreset } from "../sheet";

test.beforeAll(() => loadCatalog("ko"));

test("solo: bulk catalog promotions preserve IDs and demotion rules; inactive entries require reactivation", { tag: ["@hr", "@regression", "@negative"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await peopleWorld(browser, "peoplechoices");
  const api = apiOf(admin, bearerOf(admin));
  await go(admin, "/people/job-titles");
  await addTitle(admin, "사원", "1");
  await addTitle(admin, "선임", "2");
  await addTitle(admin, "팀장", "", "직책");
  await admin.getByRole("button", { name: "팀장 사용 중지" }).click();
  const worker = await registerAt(admin, "사람기술", "승진인", "PC-0001");
  const read = async () => (await (await api(`/employees/${worker.id}`)).json()) as { classification: { job_title_id: string | null } };
  const titles = ((await (await api("/job-titles")).json()) as { items: { id: string; label: string; active: boolean }[] }).items;

  // Hold the selected-person read: filtering the location tree must retain its loading space.
  const rosterRead = Promise.withResolvers<void>();
  const rosterRoute = "**/api/v1/employees?**";
  await admin.route(rosterRoute, async (route) => {
    // c77a524ef: the bulk action also opens the appointments tab of /people.
    const at = new URL(admin.url());
    if (at.pathname === "/people/bulk" || (at.pathname === "/people" && at.searchParams.get("tab") === "appointments")) await rosterRead.promise;
    await route.continue();
  });
  await pickBulk(admin, "PC-0001");
  // 3b6934435: the selected-person read gates the whole form until its rows settle.
  const promotion = admin.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "승진" });
  await expect(admin.getByRole("main").locator('[aria-busy="true"]')).toBeVisible();
  await expect(admin.getByRole("main").locator('[data-read-layout="form"]')).toBeVisible();
  await expect(admin.getByRole("group", { name: "무엇을" })).toHaveCount(0);
  rosterRead.resolve();
  await expect(promotion).toBeEnabled();
  await admin.unroute(rosterRoute);
  await admin.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "승진" }).click();
  await admin.getByRole("combobox", { name: "승진인의 새 직위" }).selectOption({ label: "선임" });
  await todayPreset(admin).click();
  await admin.getByRole("radiogroup", { name: /^사유/ }).getByText("정기 승진", { exact: true }).click();
  await admin.getByRole("textbox", { name: /^메모/ }).fill("정기 평가");
  await admin.getByRole("button", { name: commitLabel({ kind: "PROMOTE", mode: "apply", count: 1 }) }).click();
  await expect(admin.getByRole("status").filter({ hasText: /1명 승진/ }).first()).toBeVisible();
  expect((await read()).classification.job_title_id).toBe(titles.find((x) => x.label === "선임")!.id);

  await pickBulk(admin, "PC-0001");
  await admin.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "승진" }).click();
  await admin.getByRole("combobox", { name: "승진인의 새 직위" }).selectOption({ label: "사원" });
  const reasons = admin.getByRole("radiogroup", { name: /^사유/ });
  await expect(reasons.getByRole("radio")).toHaveCount(1);
  await expect(reasons).toContainText("강등(징계)");
  await todayPreset(admin).click();
  await admin.getByRole("textbox", { name: /^메모/ }).fill("징계 결정에 따른 강등");
  await admin.getByRole("button", { name: commitLabel({ kind: "demotion", mode: "apply", count: 1 }) }).click();
  expect((await read()).classification.job_title_id).toBe(titles.find((x) => x.label === "선임")!.id);
  await reasons.getByText("강등(징계)", { exact: true }).click();
  await admin.getByRole("button", { name: commitLabel({ kind: "demotion", mode: "apply", count: 1 }) }).click();
  await expect(admin.getByRole("status").filter({ hasText: /1명 승진/ }).first()).toBeVisible();
  expect((await read()).classification.job_title_id).toBe(titles.find((x) => x.label === "사원")!.id);

  await go(admin, `/people/${worker.id}`);
  await hrAct(admin, "직책 임면");
  const appoint = sheet(admin, /직책 임면/);
  await appoint.getByRole("button", { name: "직책 추가" }).click();
  await appoint.getByRole("textbox", { name: "새 직책 이름" }).fill("팀장");
  await appoint.getByRole("button", { name: "추가", exact: true }).click();
  await expect(appoint).toContainText("팀장은 사용 중지된 항목입니다");
  await expect(appoint.getByRole("radio", { name: "팀장", exact: true })).toHaveCount(0);
  await appoint.getByRole("button", { name: "다시 사용하고 선택" }).click();
  await expect(appoint.getByRole("radio", { name: "팀장", exact: true })).toBeChecked();
  await todayPreset(appoint).click();
  await reasonBox(appoint).fill("부서장 임면");
  await appoint.getByRole("button", { name: commitLabel({ kind: "APPOINT", mode: "apply", count: 1 }) }).click();
  await expect(appoint).toBeHidden();
  await expectAccessible(admin, "people: reactivated entry selected and recorded");
});

test("solo: a conversion correction keeps its contract end and a fixed-term refusal offers available remedies", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const { admin } = await peopleWorld(browser, "peoplecorrection");
  const api = apiOf(admin, bearerOf(admin));
  const worker = await registerAt(admin, "사람기술", "전환인", "PC-0002");
  await hrAct(admin, "고용형태 전환");
  const convert = sheet(admin, /고용형태 전환/);
  await convert.getByRole("radiogroup", { name: /^어떤 형태로/ }).getByText("계약직", { exact: true }).click();
  await todayPreset(convert).click();
  await fillDate(convert, kstDate(400), "계약 종료일");
  await reasonBox(convert).fill("기간제 전환");
  await convert.getByRole("button", { name: commitLabel({ kind: "EMPLOYMENT_TYPE_CHANGE", mode: "apply", count: 1 }) }).click();
  await expect(convert).toBeHidden();
  await openHistory(admin);
  await admin.getByRole("region", { name: "인사 이력" }).getByRole("button", { name: "정정", exact: true }).click();
  const correct = sheet(admin, /정정/);
  await expect(correct).toContainText("이 정정에서 변경할 수 없습니다");
  await expect(correct.locator('input[type="date"]')).toHaveCount(0);
  await expect(correct.getByRole("radio", { name: /^정규직/ })).toBeDisabled();
  await reasonBox(correct).fill("계약서 표기 정정");
  await correct.getByRole("radiogroup", { name: /^정정 사유/ }).getByText("입력 오류", { exact: true }).click();
  await correct.getByRole("button", { name: "고용 형태 변경 1명 정정" }).click();
  await expect(correct).toBeHidden();
  await go(admin, `/people/${worker.id}`);
  await hrAct(admin, "계약 갱신");
  const renew = sheet(admin, /계약 갱신/);
  await fillDate(renew, kstDate(401));
  await fillDate(renew, kstDate(1100), "새 계약 종료일");
  await reasonBox(renew).fill("장기 계약 갱신 검토");
  const events = async () => (await (await api(`/employees/${worker.id}/lifecycle-events`)).json()) as object;
  const eventsBefore = await events();
  const refused = admin.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/employees/${worker.id}/lifecycle-events`));
  await renew.getByRole("button", { name: "계약 갱신 1명 예약" }).click();
  expect((await refused).status()).toBe(409);
  expect(await codeOf(await refused)).toBe("fixed_term_limit");
  await expect(renew.getByRole("alert")).toContainText("이 화면에서 신청하는 기능은 아직 없습니다");
  await expect(renew.getByRole("alert")).toContainText("한도 안의 종료일");
  expect(await events()).toEqual(eventsBefore);
  await expectAccessible(admin, "people: fixed-term refusal names supported paths");
});
