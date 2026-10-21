import ExcelJS from "exceljs";
import { expect, type Page } from "@playwright/test";

// Roster import helpers: real-shaped workbooks and the upload a user makes through the file picker.

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권", "황", "안", "송", "류", "홍"];
const GIVEN = ["민준", "서연", "도윤", "지우", "하준", "서윤", "시우", "하은", "주원", "지민", "예준", "수아", "지호", "채원", "건우", "다은", "우진", "지아", "선우", "윤서", "현우", "소율", "유준", "가은"];
const POSITIONS = ["사원", "주임", "대리", "과장", "차장", "부장"];
const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** One employee row as a roster carries it. Names repeat across a few hundred rows, as real rosters do. */
export type Person = { number: string; name: string; birth: string; unit: string; position: string; hired: string; workplace: string; type: string; phone: string; rrn: string };

/**
 * `count` people numbered `${prefix}-0001…`, spread over `units`, `workplaces` (the 사업장 column as HR writes it:
 * a 사업장 name or a customer site) and `types` (고용형태 as HR words it), with dates a roster would hold.
 */
export function people(prefix: string, count: number, units: readonly string[], workplaces: readonly string[], types: readonly string[] = ["정규직"]): Person[] {
  // A synthetic 주민등록번호 per person, unique across prefixes (the import matches people on file by it).
  const seed = [...prefix].reduce((n, c) => n + c.charCodeAt(0), 0) * 1000;
  return Array.from({ length: count }, (_, i) => ({
    number: `${prefix}-${pad(i + 1, 4)}`,
    name: SURNAMES[i % SURNAMES.length]! + GIVEN[(i * 7) % GIVEN.length]!,
    birth: `${1965 + (i % 35)}-${pad((i % 12) + 1, 2)}-${pad((i % 27) + 1, 2)}`,
    unit: units[i % units.length]!,
    position: POSITIONS[i % POSITIONS.length]!,
    hired: `${2008 + (i % 18)}-${pad(((i * 5) % 12) + 1, 2)}-${pad(((i * 3) % 27) + 1, 2)}`,
    workplace: workplaces[i % workplaces.length]!,
    type: types[i % types.length]!,
    phone: `010-${pad(2000 + i, 4)}-${pad(1000 + ((i * 37) % 9000), 4)}`,
    rrn: `${String(1965 + (i % 35)).slice(2)}${pad((i % 12) + 1, 2)}${pad((i % 27) + 1, 2)}-${i % 2 ? 2 : 1}${pad((seed + i) % 1_000_000, 6)}`,
  }));
}

/** A sheet: its name and its people. */
export type RosterSheet = { name: string; rows: Person[] };

/**
 * A workbook as an HR team keeps it: one sheet per company, headers on row 1, and the personal columns an import
 * must drop (resident registration number, bank account, phone) alongside the ones it reads.
 */
export async function rosterWorkbook(sheets: readonly RosterSheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = wb.addWorksheet(s.name);
    sheet.addRow(["사번", "성명", "생년월일", "사업장", "부서", "직위", "고용형태", "입사일", "주민등록번호", "급여계좌", "휴대전화"]);
    s.rows.forEach((p, i) =>
      sheet.addRow([
        p.number,
        p.name,
        p.birth,
        p.workplace,
        p.unit,
        p.position,
        p.type,
        p.hired,
        p.rrn,
        `110-${pad(300 + i, 3)}-${pad(500000 + i * 13, 6)}`,
        p.phone,
      ]),
    );
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The first bytes of a password-protected (or DRM-wrapped) workbook: Office stores it as an OLE compound file, not
 * a zip, so nothing can read its sheets. The rest is filler of a realistic size.
 */
export const protectedWorkbook = () => Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(4096, 0)]);

/** Chooses a workbook through the drop zone's file picker, as a user does. */
export async function chooseWorkbook(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "파일 선택" }).click();
  await (await chooser).setFiles({ name, mimeType: XLSX_MIME, buffer });
  await expect(page.getByText(`선택한 파일: ${name}`)).toBeVisible();
}

/**
 * Formerly the pay period an upload carried; r3:EMP-E7-upload: an employee roster asks none (the server's is optional),
 * so there is nothing to fill. Kept so the journeys read as before.
 */
export async function payPeriod(page: Page) {
  await expect(page.getByLabel("시작일")).toHaveCount(0);
}
