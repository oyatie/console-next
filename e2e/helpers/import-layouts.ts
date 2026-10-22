import ExcelJS from "exceljs";
import { syntheticRrn } from "../../scripts/check-fixture-ids.mjs";

// Workbooks laid out the way HR teams actually keep them (IMPORT-2, decisions #25): a title and a blank line above the
// header, synonym labels, a sheet whose labels no catalog knows, a notes sheet, an empty sheet, 재직/휴직 columns.
// Every value is generated; resident registration numbers keep their shape and fail the checksum.

const pad = (n: number, w: number) => String(n).padStart(w, "0");

/** A synthetic 주민등록번호 for a birth date and gender digit, with an invalid check digit. */
export function rrn(birth: string, gender: 1 | 2 | 3 | 4, serial: number) {
  const body = `${birth.slice(2, 4)}${birth.slice(5, 7)}${birth.slice(8, 10)}${gender}${pad(serial % 100000, 5)}`;
  return syntheticRrn(body);
}

/** One person as a 인사 명부 row carries them. Empty strings are empty cells. */
export type Row = {
  number?: string;
  name: string;
  unit?: string;
  position?: string;
  hired: string;
  birth?: string;
  status?: string;
  leaveType?: string;
  leaveStart?: string;
  leaveReturn?: string;
  rrn?: string;
};

/** A sheet with a title row and a blank row above its header (row 3), and synonym labels the catalog knows. */
export function titled(name: string, title: string, rows: readonly Row[]) {
  return {
    name,
    lines: [
      [title],
      [],
      ["사원번호", "성 명", "소속", "직위", "입사일자", "생년월일", "재직구분", "휴직구분", "휴직시작일", "복직예정일", "주민번호"],
      ...rows.map((r) => [r.number ?? "", r.name, r.unit ?? "", r.position ?? "", r.hired, r.birth ?? "", r.status ?? "", r.leaveType ?? "", r.leaveStart ?? "", r.leaveReturn ?? "", r.rrn ?? ""]),
    ],
  };
}

/** A site crew sheet whose labels no catalog knows: the import cannot find its header and asks for a mapping. */
export function crew(name: string, rows: readonly Row[]) {
  return {
    name,
    lines: [["투입 인력 현황"], ["No", "근로자", "투입현장", "투입일", "비고"], ...rows.map((r, i) => [i + 1, r.name, "A고객사 현장", r.hired, ""])],
  };
}

/** The plain layout: the header on row 1 with the standard labels. */
export function plain(name: string, rows: readonly Row[]) {
  return {
    name,
    lines: [
      ["사번", "성명", "부서", "직위", "입사일", "생년월일", "주민등록번호"],
      ...rows.map((r) => [r.number ?? "", r.name, r.unit ?? "", r.position ?? "", r.hired, r.birth ?? "", r.rrn ?? ""]),
    ],
  };
}

/** A notes sheet (free text, no header) and an empty sheet, as workbooks carry them. */
export const notes = (name: string) => ({ name, lines: [["작성자: 인사팀"], ["10월 입사자는 다음 달에 반영"], ["문의: 내선 1234"]] });
export const empty = (name: string) => ({ name, lines: [] as unknown[][] });

/** The workbook, sheets in order. */
export async function workbook(sheets: readonly { name: string; lines: readonly (readonly unknown[])[] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const sheet = wb.addWorksheet(s.name);
    for (const line of s.lines) sheet.addRow([...line]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** `count` people numbered `${prefix}-0001…` with dates a roster would hold (3,000+ for the virtualised tables). */
export function many(prefix: string, count: number, units: readonly string[]): Row[] {
  const surnames = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"];
  const given = ["민준", "서연", "도윤", "지우", "하준", "서윤", "시우", "하은", "주원", "지민", "예준", "수아"];
  return Array.from({ length: count }, (_, i) => ({
    number: `${prefix}-${pad(i + 1, 4)}`,
    name: surnames[i % surnames.length]! + given[(i * 7) % given.length]!,
    unit: units[i % units.length]!,
    position: "사원",
    hired: `${2008 + (i % 18)}-${pad(((i * 5) % 12) + 1, 2)}-${pad(((i * 3) % 27) + 1, 2)}`,
    birth: `${1965 + (i % 35)}-${pad((i % 12) + 1, 2)}-${pad((i % 27) + 1, 2)}`,
  }));
}
