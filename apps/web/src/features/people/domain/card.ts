import type { components } from "@console/api/schema";

// The personnel card's pure rules (employee-ux/final spec §1.3 PII, §2 E2): default masks, the employee register items
// (Labor Standards Act Decree §20, items 1–9) and what each one holds. No copy here: the screen names the codes.

type Address = components["schemas"]["KrAddress"];
type Career = components["schemas"]["EmployeeCareer"];

const DOT = "•";
const dots = (n: number) => DOT.repeat(n);

/** birth date as shown by default: nothing of it (the reveal opens it with a reason). */
export const maskedBirth = () => `${dots(4)}-${dots(2)}-${dots(2)}`;

/** Default phone display keeps the local prefix and last four digits. */
export function maskedPhone(e164: string): string {
  const d = e164.replace(/\D/g, "").replace(/^82/, "0");
  if (d.length < 8) return dots(4);
  return `${d.slice(0, 3)}-${dots(4)}-${d.slice(-4)}`;
}

/** An e-mail as shown by default: its first letter and the top-level domain ("h••••@••••.com"). */
export function maskedEmail(email: string): string {
  const [user = "", host = ""] = email.split("@");
  const tld = host.includes(".") ? host.slice(host.lastIndexOf(".")) : "";
  return `${user.slice(0, 1)}${dots(4)}@${dots(4)}${tld}`;
}

/** Default address display keeps province and district only. */
export const maskedAddress = (a: Address) => [a.si_nm, a.sgg_nm, dots(4)].filter(Boolean).join(" ");

/** The whole address as printed. */
export const fullAddress = (a: Address) => a.as_printed ?? [a.road_addr_part1, a.road_addr_part2, a.detail].filter(Boolean).join(" ");

/** Register items 1–9 (Decree §20): which hold a value. `null` = not entered; the screen words each. */
export type RegisterItem = { no: number; key: "name" | "sex" | "birth" | "address" | "history" | "job" | "contract" | "exit" | "note"; present: boolean };

export function registerItems(f: {
  name: string;
  sex: string | null | undefined;
  birth: string | null | undefined;
  address: Address | null | undefined;
  careers: Career[] | null | undefined;
  job: string | null | undefined;
  hireDate: string | null | undefined;
  exited: boolean;
  exitReason: string | null | undefined;
}): RegisterItem[] {
  return [
    { no: 1, key: "name", present: Boolean(f.name) },
    { no: 2, key: "sex", present: Boolean(f.sex) },
    { no: 3, key: "birth", present: Boolean(f.birth) },
    { no: 4, key: "address", present: Boolean(f.address) },
    // "no prior career" ([]) is a recorded answer; only null is missing.
    { no: 5, key: "history", present: f.careers != null },
    { no: 6, key: "job", present: Boolean(f.job) },
    { no: 7, key: "contract", present: Boolean(f.hireDate) },
    // dismissal and exit is "not applicable" while employed.
    { no: 8, key: "exit", present: !f.exited || Boolean(f.exitReason) },
    // other is optional by law: never a gap.
    { no: 9, key: "note", present: true },
  ];
}

/** The register's gap count ("nmissing"), never a refusal. */
export const registerGaps = (items: RegisterItem[]) => items.filter((i) => !i.present).length;

/** service length in whole years and months from the hire date to `today` (both YYYY-MM-DD); null before the hire date. */
export function serviceSpan(hire: string, today: string): { years: number; months: number } | null {
  if (hire > today) return null;
  const [hy, hm, hd] = hire.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  let months = (ty - hy) * 12 + (tm - hm) - (td < hd ? 1 : 0);
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12 };
}

/** The first letter of a name, for the photo placeholder. */
export const initial = (name: string) => Array.from(name.trim())[0] ?? "";

/** Where `id` sits in `ids` (1-based) and its neighbours, for "5 / 88" and J/K. */
export function listPosition(ids: readonly string[], id: string) {
  const at = ids.indexOf(id);
  if (at < 0) return null;
  return { index: at + 1, total: ids.length, prev: ids[at - 1] ?? null, next: ids[at + 1] ?? null };
}
