import ExcelJS from "exceljs";
import { expect, type Browser, type Page } from "@playwright/test";
import { go } from "../flows";
import { addDepartments } from "../structure-flows";
import { registerBranch, tenantInSetup } from "../setup-flows";
import { rrn } from "../helpers/import-layouts";

// The employee screens' data universe (employee-ux/final spec §7, scaled down): one 법인 새온정밀 with 서울 본사 and
// 평택공장, a few 부서, and ~40 people, every one created through the product from an empty database (the import
// API under the admin's own session, as e2e/roster.spec.ts does, then the record's own screens). The mockups'
// 1,236 people and 3 법인 are out of reach for a capture run; the shape (same columns, same states) is kept.

export type Row = { no: string; name: string; birth: string; site: string; unit: string; position: string; type: string; hired: string; exit?: string; leave?: [string, string]; rrn?: string };

const SEOUL = "서울 본사";
const PT = "평택공장";
/** Each 부서 under its parent (a 사업장 or a 부서). */
export const UNITS = [
  [SEOUL, "경영지원본부"],
  ["경영지원본부", "인사팀"],
  [PT, "생산부"],
  ["생산부", "생산1팀"],
  ["생산부", "생산2팀"],
  [PT, "품질관리부"],
] as const;

/** The hero of the card frames (E2): 윤하준 10587, 입사 2019-03-14 into 생산2팀 as 사원; history.ts gives the 발령 since. */
export const HERO = { no: "10587", name: "윤하준" };

// The roster rows the E1 mockup lists first, then 생산1팀 around the hero, two 김민서 (동명이인, E1-dup), three exits
// (E9) and one start ahead of today (입사 예정).
export const ROWS: Row[] = [
  ["10001", "정하린", "1971-02-11", SEOUL, "", "부장", "정규직", "2008-07-03"],
  ["10356", "정현석", "1979-05-02", SEOUL, "", "차장", "정규직", "2017-02-07"],
  ["10707", "허서후", "1988-09-23", SEOUL, "", "과장", "정규직", "2026-02-07"],
  ["10236", "차다은", "1992-12-01", SEOUL, "", "사원", "정규직", "2014-06-25"],
  ["10003", "한서윤", "1970-03-30", SEOUL, "경영지원본부", "부장", "정규직", "2008-11-27"],
  ["10317", "노예은", "1980-07-14", SEOUL, "경영지원본부", "차장", "정규직", "2016-02-08"],
  ["10169", "곽시안", "1983-01-19", SEOUL, "경영지원본부", "과장", "정규직", "2011-05-16"],
  ["10094", "문지호", "1985-04-08", SEOUL, "인사팀", "과장", "정규직", "2010-03-02"],
  ["10627", "조예원", "1990-10-27", SEOUL, "인사팀", "대리", "정규직", "2024-03-18"],
  ["10579", "이기현", "1994-06-05", SEOUL, "인사팀", "사원", "정규직", "2022-07-25"],
  ["10128", "원소율", "1991-08-18", SEOUL, "인사팀", "대리", "계약직", "2024-11-16"],
  ["10541", "권새봄", "1993-02-22", SEOUL, "인사팀", "주임", "정규직", "2021-06-18"],
  ["10115", "유다은", "1987-11-03", SEOUL, "인사팀", "주임", "정규직", "2011-06-08"],
  ["10628", "마지원", "1998-05-29", SEOUL, "인사팀", "사원", "정규직", "2024-03-16"],
  ["10083", "공지우", "1986-12-12", SEOUL, "인사팀", "사원", "정규직", "2010-10-18"],
  ["10420", "서도윤", "1981-03-09", PT, "생산부", "부장", "정규직", "2018-01-02"],
  ["10587", "윤하준", "1994-08-21", PT, "생산2팀", "사원", "정규직", "2019-03-14"],
  ["10422", "김태현", "1989-06-30", PT, "생산1팀", "대리", "정규직", "2018-04-02"],
  ["10517", "김은지", "1996-01-15", PT, "생산1팀", "사원", "정규직", "2021-01-04"],
  ["10648", "방하람", "1997-07-07", PT, "생산1팀", "사원", "계약직", "2024-11-16"],
  ["10618", "조경수", "1995-10-10", PT, "생산1팀", "사원", "계약직", "2024-10-21"],
  ["10578", "문채원", "1999-02-02", PT, "생산1팀", "사원", "정규직", "2022-06-07"],
  ["10611", "남궁별", "1990-09-09", PT, "생산1팀", "주임", "정규직", "2020-05-11"],
  ["10630", "도하늘", "1993-04-04", PT, "생산1팀", "사원", "정규직", "2023-02-06"],
  ["10014", "허송이", "1988-03-03", PT, "생산2팀", "대리", "정규직", "2013-09-02"],
  ["10650", "송다인", "1995-12-24", PT, "생산2팀", "사원", "정규직", "2024-01-08"],
  ["10652", "황보람", "1992-06-16", PT, "생산2팀", "사원", "정규직", "2023-08-21"],
  ["10380", "임채윤", "1984-08-08", PT, "품질관리부", "과장", "정규직", "2015-03-02"],
  ["30043", "김민서", "1998-04-12", PT, "품질관리부", "사원", "정규직", "2023-03-06"],
  ["30135", "김민서", "1998-04-27", PT, "생산2팀", "사원", "정규직", "2026-10-02"],
  ["10655", "백시우", "1996-11-11", PT, "생산2팀", "사원", "정규직", "2026-11-02"],
  // Exits within the 3-year retention (E9).
  ["10201", "최도현", "1982-02-02", PT, "생산1팀", "대리", "정규직", "2012-04-02", "2025-11-16"],
  ["10255", "강하율", "1990-05-05", SEOUL, "인사팀", "사원", "정규직", "2016-08-01", "2024-02-29"],
  ["10310", "오지안", "1993-03-21", PT, "생산2팀", "사원", "계약직", "2023-01-02", "2024-12-31"],
].map(([no, name, birth, site, unit, position, type, hired, exit]) => ({
  no: no!, name: name!, birth: birth!, site: site!, unit: unit!, position: position!, type: type!, hired: hired!, exit: exit || undefined,
  // 허송이 on 육아휴직 (재직 + 휴직 = 인원); the hero's 주민등록번호 (synthetic, valid shape) goes to the sealed field (decision #25).
  ...(no === "10014" && { leave: ["2026-08-01", "2027-07-31"] as [string, string] }),
  ...(no === HERO.no && { rrn: rrn(birth!, 1, 587) }),
}));

/** The roster as an HR team keeps it: one sheet, headers on row 1. The 사업장 follows each 부서 (decisions #18). */
async function workbook(rows: readonly Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("새온정밀");
  sheet.addRow(["사번", "성명", "생년월일", "부서", "직위", "고용형태", "입사일", "퇴사일", "재직상태", "휴직구분", "휴직시작일", "복직예정일", "주민등록번호"]);
  for (const r of rows)
    sheet.addRow([r.no, r.name, r.birth, r.unit || r.site, r.position, r.type, r.hired, r.exit ?? "", r.leave ? "휴직" : "", r.leave ? "육아휴직" : "", r.leave?.[0] ?? "", r.leave?.[1] ?? "", r.rrn ?? ""]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The signed-in page's own access token, read off the app's next API call (e2e/roster.spec.ts). */
export async function bearer(page: Page) {
  const call = page.waitForRequest((r) => r.url().includes("/api/v1/") && Boolean(r.headers().authorization));
  // A fresh load: an in-app visit may be served from the cache without a request to read the token off.
  await page.goto("/people");
  return (await call).headers().authorization!;
}

type Json = Record<string, unknown>;
export type Call = <T>(method: "get" | "post", path: string, body?: { multipart?: Json; data?: unknown; headers?: Record<string, string> }, ok?: number[]) => Promise<T>;
/** The product's API under the admin's own session (the app's token); a status outside `ok` fails the step. */
export async function apiOf(admin: Page): Promise<Call> {
  const authorization = await bearer(admin);
  return async <T>(method: "get" | "post", path: string, body?: { multipart?: Json; data?: unknown; headers?: Record<string, string> }, ok = [200]) => {
    const res = await admin.request[method](path, { timeout: 60_000, ...(body as object), headers: { authorization, ...body?.headers } });
    expect(ok, `${path}: ${res.status()} ${await res.text()}`).toContain(res.status());
    return (res.status() === 204 ? null : await res.json().catch(() => null)) as T;
  };
}

/** The import's preview → dry run (every unit, 사업장 and 고용형태 answered) → apply, under the admin's session. */
async function importRows(admin: Page, rows: readonly Row[]) {
  const call = await apiOf(admin);
  const chart = await call<{ items: { id: string; name: string }[] }>("get", "/api/v1/org-units");
  const units = new Map(chart.items.map((u) => [u.name, u.id]));
  const file = { name: "인사명부.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: await workbook(rows) };
  const { run_id } = await call<{ run_id: string }>("post", "/api/v1/employees/import/preview", { multipart: { file, pay_period_start: "2026-10-01", pay_period_end: "2026-10-31" } });
  const names = [...new Set(rows.map((r) => r.unit || r.site))];
  const decisions = {
    unit_map: Object.fromEntries(names.map((n) => [n, units.get(n) ?? null])),
    employment_type_map: { 정규직: "REGULAR", 계약직: "CONTRACT" },
  };
  const { dry_run_digest } = await call<{ dry_run_digest: string }>("post", `/api/v1/employees/import/${run_id}/dry-run`, { data: { decisions } });
  await call("post", `/api/v1/employees/import/${run_id}/apply`, { data: { dry_run_digest } });
}

/** 새온 in its setup phase: 법인 새온정밀 · 서울 본사 + 평택공장 · the 부서 tree, nobody yet (E12-first-run). */
export async function saeonInSetup(browser: Browser, slug = "saeon") {
  // Each spec that builds 새온 runs in its own tenant (a slug per test), so parallel workers never share one.
  const t = await tenantInSetup(browser, slug, "새온정밀", false, SEOUL);
  const { admin } = t;
  // 평택공장 has its own certificate (a 지점 of the same corporation): 운영 시작 needs it before anyone is placed there.
  await registerBranch(admin, "새온정밀", PT, "0008512347");
  // The 부서 tree on the org chart (trunk's cs-chart replaced the setup tree; /setup/org redirects to /org).
  await go(admin, "/org");
  for (const [parent, unit] of UNITS) await addDepartments(admin, parent, [unit]);
  return t;
}

/** The roster through the import. */
export async function staffSaeon(admin: Page) {
  await importRows(admin, ROWS);
}
