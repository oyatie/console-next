// SPDX-License-Identifier: LicenseRef-Proprietary

const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5] as const;
const CRN_WEIGHTS = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2] as const;
const BRN_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5] as const;

export function padDigits(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Deterministic 13-digit CRN under unallocated 000 prefix, 7th digit 9 to avoid RRN pattern matches. */
export function syntheticCrn(entityOrdinal: number): string {
  const body = `0002119${padDigits(12340 + entityOrdinal, 5)}`;
  const sum = [...body].reduce((acc, ch, idx) => acc + Number(ch) * CRN_WEIGHTS[idx]!, 0);
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

export function crnChecksumValid(crnDigits: string): boolean {
  const digits = crnDigits.replaceAll("-", "");
  if (!/^\d{13}$/.test(digits)) return false;
  const sum = CRN_WEIGHTS.reduce((acc, weight, idx) => acc + Number(digits[idx]) * weight, 0);
  return ((10 - (sum % 10)) % 10) === Number(digits[12]);
}

export function formatCrn(crnDigits: string): string {
  const digits = crnDigits.replaceAll("-", "");
  return `${digits.slice(0, 6)}-${digits.slice(6)}`;
}

/** Deterministic 10-digit BRN under unallocated 000 prefix (81 head office, 85 branch). */
export function syntheticBrn(entityOrdinal: number, siteIndex: number, headOffice: boolean): string {
  const kind = headOffice ? "81" : "85";
  const serial = entityOrdinal * 1000 + siteIndex + 101;
  const body = `000${kind}${padDigits(serial % 10_000, 4)}`;
  const weighted = BRN_WEIGHTS.reduce((acc, weight, idx) => acc + Number(body[idx]) * weight, 0);
  const sum = weighted + Math.floor((Number(body[8]) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}

export function brnChecksumValid(brnDigits: string): boolean {
  const digits = brnDigits.replaceAll("-", "");
  if (!/^\d{10}$/.test(digits)) return false;
  const weighted = BRN_WEIGHTS.reduce((acc, weight, idx) => acc + Number(digits[idx]) * weight, 0);
  const sum = weighted + Math.floor((Number(digits[8]) * 5) / 10);
  return ((10 - (sum % 10)) % 10) === Number(digits[9]);
}

export function formatBrn(brnDigits: string): string {
  const digits = brnDigits.replaceAll("-", "");
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

/**
 * Deterministic synthetic RRN that preserves a real YYYY-MM-DD birth date and century/gender digit 1..8
 * while offsetting the final check digit by +1 mod 10 so it never matches a checksum-valid RRN.
 */
export function syntheticInvalidRrn(birthDate: string, genderDigit: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, serial: number): string {
  const yymmdd = `${birthDate.slice(2, 4)}${birthDate.slice(5, 7)}${birthDate.slice(8, 10)}`;
  const body = `${yymmdd}${genderDigit}${padDigits(Math.abs(serial) % 100_000, 5)}`;
  const sum = RRN_WEIGHTS.reduce((acc, weight, idx) => acc + Number(body[idx]) * weight, 0);
  const validCheck = (11 - (sum % 11)) % 10;
  const invalidCheck = (validCheck + 1) % 10;
  return `${yymmdd}-${body.slice(6)}${invalidCheck}`;
}

export function rrnChecksumValid(rrnDigits: string): boolean {
  const digits = rrnDigits.replaceAll("-", "");
  if (!/^\d{13}$/.test(digits)) return false;
  const sum = RRN_WEIGHTS.reduce((acc, weight, idx) => acc + Number(digits[idx]) * weight, 0);
  return ((11 - (sum % 11)) % 10) === Number(digits[12]);
}

export function maskRrn(rrn: string): string {
  const clean = rrn.replaceAll("-", "");
  return `${clean.slice(0, 6)}-${clean[6] ?? "1"}${"\u25cf".repeat(6)}`;
}

export function maskMobilePhone(phone: string): string {
  const digits = phone.replaceAll("-", "");
  return `${digits.slice(0, 3)}-${"\u25cf".repeat(4)}-${digits.slice(-4)}`;
}
