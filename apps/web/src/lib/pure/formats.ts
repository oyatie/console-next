// Korean identifier, phone and number formats (design §2.2, §7.4). Values are kept canonical (ASCII digits
// only) and shown through a mask; a checksum that fails is a warning, never a refusal: the server and the
// National Tax Service (NTS) lookup are authoritative. Pure: no DOM, no copy (warnings are codes the view translates).

/** ASCII digits only. Full-width digits (０-９) count as digits; everything else is dropped. */
export const digitsOf = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, "");

/** Fills `#` slots of `mask` with `digits`, stopping at the last digit (no dangling separators). */
export function applyMask(digits: string, mask: string) {
  let out = "";
  let i = 0;
  for (const ch of mask) {
    if (i >= digits.length) break;
    out += ch === "#" ? digits[i++] : ch;
  }
  return out + digits.slice(i);
}

export type Warning = "checksum";
/** A masked number kind: how many digits it holds, how it is shown, and its soft checks. */
export type Format = {
  /** The most digits it takes; typing stops there. */
  max: number;
  /** The fewest digits a complete value has (equal to `max` for fixed-length identifiers). */
  min: number;
  display: (digits: string) => string;
  /** Canonical digits of typed or pasted text, before the `max` cut (default: digitsOf). */
  parse?: (raw: string) => string;
  /** Soft checks on a complete value; empty when it passes or no check applies. */
  warnings?: (digits: string, facts?: { incorporatedOn?: string }) => Warning[];
};

/**
 * Business registration number (BRN) check digit: the widely used weighted sum (1,3,7,1,3,7,1,3,5, plus ⌊5·d9/10⌋). No primary
 * source defines it (law.md §6), so a mismatch only warns.
 */
export function bizRegNoChecksumOk(d: string) {
  if (!/^\d{10}$/.test(d)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = w.reduce((s, k, i) => s + k * Number(d[i]), 0);
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

/** Corporate registration number (CRN) check digit (registration-number rules, annex 4: weights 1,2,1,2…, check = (10 − sum mod 10) mod 10). */
export function corpRegNoChecksumOk(d: string) {
  if (!/^\d{13}$/.test(d)) return false;
  const sum = [...d.slice(0, 12)].reduce((s, c, i) => s + Number(c) * (i % 2 ? 2 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(d[12]);
}

/** Numbers issued from this date carry no check digit (law.md §6), so the check runs only before it. */
export const CORP_CHECK_DIGIT_UNTIL = "2025-01-31";

/** Korean domestic phone display: 02-123-4567, 031-123-4567, 010-1234-5678, 1588-1234. `+82…` is read as 0…. */
export function phoneDisplay(raw: string) {
  const d = toDomestic(raw);
  if (/^1[5-9]/.test(d)) return applyMask(d, "####-####");
  if (d.startsWith("02")) return applyMask(d, d.length <= 9 ? "##-###-####" : "##-####-####");
  return applyMask(d, d.length <= 10 ? "###-###-####" : "###-####-####");
}
/** Domestic digits of a phone number typed with or without +82 (a leading 0 is restored). */
export const toDomestic = (raw: string) => {
  const d = digitsOf(raw);
  return raw.trim().startsWith("+82") || (d.startsWith("82") && d.length >= 11) ? `0${d.slice(2).replace(/^0/, "")}` : d;
};
/** E.164 (`+82…`) of a complete Korean number, else null. */
export function phoneE164(raw: string) {
  const d = toDomestic(raw);
  const ok = /^1[5-9]\d{6}$/.test(d) || /^0\d{8,10}$/.test(d);
  return ok ? `+82${d.replace(/^0/, "")}` : null;
}

export const FORMATS = {
  /** RRN: length and display only; the server decides validity. */
  rrn: { max: 13, min: 13, display: (d) => applyMask(d, "######-#######") },
  /** BRN ###-##-#####. */
  bizRegNo: { max: 10, min: 10, display: (d) => applyMask(d, "###-##-#####"), warnings: (d) => (bizRegNoChecksumOk(d) ? [] : ["checksum"]) },
  /** CRN ######-#######; the check digit is tested only when the corporation is known to predate 2025-01-31. */
  corpRegNo: {
    max: 13,
    min: 13,
    display: (d) => applyMask(d, "######-#######"),
    warnings: (d: string, f?: { incorporatedOn?: string }) => (f?.incorporatedOn && f.incorporatedOn < CORP_CHECK_DIGIT_UNTIL && !corpRegNoChecksumOk(d) ? ["checksum"] : []),
  },
  /** Sub-workplace serial ####. */
  subSerial: { max: 4, min: 4, display: (d) => d },
  /** Social insurance workplace number: no primary source fixes a format (law.md §6), so a length band and groups of 4. */
  insuranceNo: { max: 13, min: 8, display: (d) => d.replace(/(\d{4})(?=\d)/g, "$1 ") },
  /** NTS industry code ######. */
  ntsIndustry: { max: 6, min: 6, display: (d) => d },
  phone: { max: 11, min: 8, display: phoneDisplay, parse: toDomestic },
} as const satisfies Record<string, Format>;
export type FormatName = keyof typeof FORMATS;

/** The canonical value of typed or pasted text: digits only, cut at the format's length. */
export const parseWith = (f: Format, raw: string) => (f.parse ?? digitsOf)(raw).slice(0, f.max);

/** True when `d` has a complete value's length for `f`. */
export const complete = (f: Format, d: string) => d.length >= f.min && d.length <= f.max;

/** Exactly one @, a dotted domain, at most 254 characters (no DNS lookups; the server decides). */
export const validEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
