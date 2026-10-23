import { expect, test } from "@playwright/test";
import { todayPreset } from "../sheet";
import { expectAccessible } from "../a11y";
import { go, registerEmployee } from "../flows";
import { staffedTenant } from "../setup-flows";
import { apiOf, bearerOf, codeOf } from "../helpers/api";
import { forgetResize } from "../stability";
import { OUT, shot, VIEW } from "../parity/shot";

// With PARITY_OUT set this journey also draws the mockup frames E5-notice (make) and E5-notice--full (the document).
if (OUT) test.use(VIEW);

// 발령 공고 (spec E5-notice, BE-EMP-UI §4) from an empty company: a bulk transfer of two, then its notice made from the
// receipt with the company's next 발령 번호 and read as a document. The server keeps the line: the same batch on a
// second notice is 409 appointment_notice_event_taken naming the first notice's number (and no number is used), a
// notice without its Idempotency-Key is refused, and an empty title too.

test("notice: a bulk transfer's 발령 공고 takes the next number; the same acts on a second notice are refused", { tag: ["@hr", "@negative"] }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await staffedTenant(browser, "notco", "공고주식회사");
  const api = apiOf(admin, bearerOf(admin));
  const names = ["표진우", "전하윤"];
  for (const [i, name] of names.entries()) await registerEmployee(admin, { name, number: `NT-000${i + 1}`, unit: "인사부" });

  await go(admin, "/people");
  const find = admin.getByRole("searchbox", { name: "이름 또는 사번" });
  await find.fill("");
  await find.press("Enter");
  for (const name of names) await admin.getByRole("row", { name: new RegExp(name) }).locator("label", { has: admin.getByRole("checkbox") }).click();
  await admin.getByRole("button", { name: "선택한 2명 일괄 발령" }).click();
  await admin.getByRole("group", { name: "무엇을" }).getByRole("button", { name: "전보" }).click();
  await admin.getByRole("listbox", { name: "어디로" }).getByRole("option", { name: /^채용팀/ }).click();
  await todayPreset(admin).click();
  await admin.getByRole("radiogroup", { name: /^사유/ }).getByText("조직 개편", { exact: true }).click();
  await admin.getByRole("textbox", { name: /^메모/ }).fill("조직 개편");
  await admin.getByRole("button", { name: "전보 2명 반영" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "2명 전보 반영함" })).toBeVisible();

  // From the receipt: the notice for this batch. A commit without a date names the gap and makes nothing.
  await admin.getByRole("link", { name: "발령 공고 작성" }).click();
  await expect(admin.getByRole("heading", { name: "발령 공고 작성", level: 1 })).toBeVisible();
  // The checks below are this page's (the workspace before it is j6-bulk's).
  await forgetResize(admin);
  await admin.getByRole("button", { name: /^발령 번호 받고 공고 작성/ }).click();
  await expect(admin.getByText("공고일을 선택하십시오")).toBeVisible();
  expect(((await (await api("/appointment-notices")).json()) as { items: unknown[] }).items).toHaveLength(0);
  await todayPreset(admin).click();
  await expectAccessible(admin, "E5-notice: make");
  if (OUT) await shot(admin, "E5-notice");
  await admin.getByRole("button", { name: /^발령 번호 받고 공고 작성/ }).click();

  // The document: 「인 사 발 령」 with the number, one section of two transfers, nothing personal beyond name and 사번.
  const year = new Date().getFullYear();
  const doc = admin.getByRole("article", { name: new RegExp(`인사발령 제${year}-0001호`) });
  await expect(doc).toBeVisible({ timeout: 15_000 });
  await expect(doc).toContainText("1. 전보 (2명)");
  for (const name of names) await expect(doc.getByRole("row", { name: new RegExp(name) })).toContainText("채용팀");
  await expectAccessible(admin, "E5-notice: document");
  if (OUT) await shot(admin, "E5-notice", { full: true });

  // Made again from the same receipt (back, a second press): the page names the notice that already holds these acts.
  await admin.goBack();
  await expect(admin.getByRole("heading", { name: "발령 공고 작성", level: 1 })).toBeVisible();
  await todayPreset(admin).click();
  await admin.getByRole("button", { name: /^발령 번호 받고 공고 작성/ }).click();
  await expect(admin.getByRole("alert")).toContainText(`이미 제${year}-0001호 공고에 들어 있는 발령`);
  await expect(admin.getByRole("heading", { name: "발령 공고 작성", level: 1 })).toBeVisible();

  // The server's line: the same batch again is refused with the first notice's number; no number is used.
  const [first] = ((await (await api("/appointment-notices")).json()) as { items: { id: string; notice_no: string }[] }).items;
  const detail = (await (await api(`/appointment-notices/${first!.id}`)).json()) as { lines: { event: { batch_id?: string } }[] };
  const batch = detail.lines[0]!.event.batch_id!;
  const body = { title: "인사발령", notice_date: `${year}-12-01`, batch_id: batch };
  const again = await api("/appointment-notices", "POST", body, { "Idempotency-Key": crypto.randomUUID() });
  expect([again.status(), await codeOf(again)]).toEqual([409, "appointment_notice_event_taken"]);
  expect(await again.text()).toContain(first!.notice_no);
  const noKey = await api("/appointment-notices", "POST", body);
  expect(noKey.status()).toBe(422);
  const blank = await api("/appointment-notices", "POST", { ...body, title: " " }, { "Idempotency-Key": crypto.randomUUID() });
  expect(blank.status()).toBe(422);
  expect(((await (await api("/appointment-notices")).json()) as { items: unknown[] }).items).toHaveLength(1);
});
