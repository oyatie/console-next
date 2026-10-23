import { expect, test, type Browser, type Page, type Request } from "@playwright/test";
import { authenticatorOf, virtualAuthenticator } from "./auth";
import { go, kstDate, newContext, passkeyLogin, registerEmployee } from "./flows";
import { openTenant } from "./helpers/tenant";
import { expectAccessible } from "./a11y";
import { homeRail, staffedTenant, tenantInSetup } from "./setup-flows";
import { expectStable } from "./stability";
import { addDepartments } from "./structure-flows";
import { sheet as actSheet } from "./sheet";
import { hrAct } from "./record";

// Decision #27 (FE-RT-7 subset): what one session changes reaches another session's open screen through the shell's
// one event stream, with no reload and no timed re-read; a stream cut mid-use shows its outage and catches up when it
// is back; a user outside the change's scope (another tenant) is told nothing. Needs a backend whose hub emits
// `change` frames on GET /api/v1/events (RT-4, wired by INT-RT).

const STREAM = "/api/v1/events";
const exitPanel = (page: Page) => page.getByRole("region", { name: "퇴직", exact: true });
const outage = (page: Page) => page.getByText("실시간 연결 끊김 · 재연결 중");

/** Every request a page makes, in order: the stream, and data reads (GETs under /api/ other than auth). */
function track(page: Page) {
  const log: { stream: boolean; url: string }[] = [];
  page.on("request", (r: Request) => {
    const { pathname, search } = new URL(r.url());
    if (pathname === STREAM) log.push({ stream: true, url: pathname });
    else if (r.method() === "GET" && pathname.startsWith("/api/") && !pathname.startsWith("/api/v1/auth/")) log.push({ stream: false, url: pathname + search });
  });
  const reads = (from = 0, to = log.length) => log.slice(from, to).filter((e) => !e.stream).map((e) => e.url);
  /** Reads since `from` that repeat a read (made before `from`, or twice since): a re-read. */
  const rereads = (from: number) => {
    const seen = new Set(reads(0, from));
    return reads(from).filter((u) => seen.has(u) || !seen.add(u));
  };
  return { log, reads, rereads, mark: () => log.length };
}

/** The same account signed in on a second browser (its own context: no shared tab state, its own stream). */
async function sameUserElsewhere(browser: Browser, page: Page) {
  const other = await (await newContext(browser)).newPage();
  await (await virtualAuthenticator(other)).import(await authenticatorOf(page).export());
  const t = track(other);
  await other.goto("/login");
  await passkeyLogin(other);
  return { page: other, ...t };
}

test("a change in one session reaches another without reload or polling, survives a cut stream, and stays in its tenant", { tag: "@live" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await staffedTenant(browser, "liveco", "실시간주식회사");
  await registerEmployee(admin, { name: "한실시간", number: "LV-0001", hired: "2024-03-04" });
  const record = new URL(admin.url()).pathname;
  const outsider = await openTenant(browser, "liveout", "다른회사");
  const out = track(outsider);

  // B: the same account in another browser. The shell opens its one stream before any screen's read.
  const b = await sameUserElsewhere(browser, admin);
  const firstStream = b.log.findIndex((e) => e.stream);
  const firstRead = b.log.findIndex((e) => !e.stream);
  expect(firstStream, "the stream opens").toBeGreaterThanOrEqual(0);
  expect(firstStream, "before the first data read").toBeLessThan(firstRead < 0 ? Infinity : firstRead);
  await go(b.page, record);
  await expect(exitPanel(b.page)).toBeVisible();

  // Nothing re-reads on a timer or on focus: idle past the old 30 s poll, with focus and visibility toggled. (A
  // screen's late first read, e.g. a debounced search, is not a re-read.)
  const idle = b.mark();
  await b.page.evaluate(() => {
    for (const type of ["blur", "focus"]) window.dispatchEvent(new Event(type));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await b.page.waitForTimeout(31_000);
  expect(b.rereads(idle), "no re-read without a change").toEqual([]);

  // A reports the exit; B's open record shows it, says it changed elsewhere, and re-read it once, without a reload.
  const loads = { n: 0 };
  b.page.on("load", () => void loads.n++); // a full document load only (in-app navigation pushes history)
  const before = b.mark();
  const outBefore = out.mark();
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const sheet = admin.getByRole("dialog");
  await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(30));
  await sheet.getByLabel("퇴직 경위").fill("실시간 확인");
  await sheet.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
  await expect(exitPanel(admin)).toContainText("보고됨");
  await expect(exitPanel(b.page)).toContainText("보고됨", { timeout: 15_000 });
  await expect(b.page.getByRole("status").filter({ hasText: "다른 곳에서 바뀌어" })).toBeVisible();
  expect(loads.n, "no reload").toBe(0);
  expect(b.reads(before).length, "the change re-read what B shows").toBeGreaterThan(0);
  expect(new Set(b.reads(before)).size, `each read once: ${b.reads(before).join(", ")}`).toBe(b.reads(before).length);

  // The other tenant's ops account was told nothing: its open screen read nothing since the change.
  await outsider.waitForTimeout(1_000); // past the 250 ms invalidation debounce
  expect(out.rereads(outBefore), "out of scope: no frame, no re-read").toEqual([]);

  // The stream is cut and cannot come back: the shell says so; A withdraws the report meanwhile. Whether going offline
  // ends an in-flight streaming fetch is not verified: if it does not, the reader aborts the silent connection after
  // two missed heartbeats (2 × 25 s), so this step may take ~55 s.
  await b.page.route(`**${STREAM}`, (r) => r.abort());
  await b.page.context().setOffline(true);
  await expect(outage(b.page)).toBeVisible({ timeout: 60_000 });
  await b.page.context().setOffline(false);
  await admin.getByRole("button", { name: "퇴직 취소" }).click();
  const withdraw = admin.getByRole("dialog", { name: "퇴직 취소" });
  await withdraw.getByLabel("취소 사유").fill("실시간 재연결 확인");
  await withdraw.getByRole("button", { name: "퇴직 1명 취소" }).click();
  await expect(exitPanel(admin)).toContainText("취소됨");
  await expect(exitPanel(b.page)).toContainText("보고됨"); // still the old read: nothing polled while cut

  // Back: the reconnect resumes (or, with no cursor, re-reads once) and the withdrawal shows; the outage clears.
  await b.page.unroute(`**${STREAM}`);
  await expect(exitPanel(b.page)).toContainText("취소됨", { timeout: 45_000 });
  await expect(outage(b.page)).toHaveCount(0);
  expect(loads.n, "no reload").toBe(0);
});

const held = (page: Page) => page.getByRole("button", { name: /^새 항목 \d+건 · 새로 고침$/ });

test("an unattended Home holds a change made elsewhere behind its notice: nothing moves until the press", { tag: "@live" }, async ({ browser }) => {
  test.setTimeout(180_000);
  // Regression (j2-transfer, round 22): the executive's Home checklist moved while the admin's setup writes streamed in.
  const { admin, exec } = await tenantInSetup(browser, "livehome", "홈실시간");
  await go(exec, "/");
  const rail = await homeRail(exec);
  await expect(rail).toBeVisible();
  await expectStable(exec, "Home before the change elsewhere");
  const before = await rail.innerText();

  await go(admin, "/org");
  await addDepartments(admin, "본점", ["총무부"]);
  await expect(held(exec)).toBeVisible({ timeout: 15_000 });
  expect(await rail.innerText(), "held: the checklist is as it was").toBe(before);
  await expectStable(exec, "unattended Home after a change elsewhere");
  await expectAccessible(exec, "Home with held changes");

  await held(exec).click();
  await expect(held(exec)).toHaveCount(0);
  await expect.poll(() => rail.innerText(), { timeout: 15_000 }).not.toBe(before);
});

test("a sheet holds a change made elsewhere to the record under it, and closing it shows the change", { tag: "@live" }, async ({ browser }) => {
  test.setTimeout(240_000);
  const { admin } = await staffedTenant(browser, "livesheet", "시트실시간주식회사");
  await registerEmployee(admin, { name: "한보류", number: "LS-0001", hired: "2024-03-04" });
  const record = new URL(admin.url()).pathname;
  const b = await sameUserElsewhere(browser, admin);
  await go(b.page, record);
  await expect(exitPanel(b.page)).toBeVisible();

  // B is working in a sheet over the record when A reports the exit.
  await hrAct(b.page, "전보");
  const open = actSheet(b.page, "한보류 전보"); // the act's sheet names the act; the person is on its kicker
  await expect(open).toBeVisible();
  const mark = b.mark();
  await admin.getByRole("button", { name: "퇴직 보고" }).click();
  const sheet = admin.getByRole("dialog");
  await sheet.getByRole("textbox", { name: /^마지막 근무일/ }).fill(kstDate(30));
  await sheet.getByLabel("퇴직 경위").fill("시트 보류 확인");
  await sheet.getByRole("button", { name: "퇴직 보고 1명 반영" }).click();
  await expect(exitPanel(admin)).toContainText("보고됨");

  // Past the frame and its debounce: nothing under (or in) the open sheet was re-read or redrawn.
  await b.page.waitForTimeout(3_000);
  expect(b.rereads(mark), "no re-read while the sheet is open").toEqual([]);
  await expect(exitPanel(b.page)).not.toContainText("보고됨");

  // Closing applies the held change: one re-read, the record shows the report.
  await open.getByRole("button", { name: "닫기" }).click();
  await expect(open).toBeHidden();
  await expect(exitPanel(b.page)).toContainText("보고됨", { timeout: 15_000 });
});
