// Legal, short, and English names are separate facts; certificate item 1 supplies the legal name.
import type { LegalEntity } from "@console/api/pending";
import { i18n } from "@console/i18n";
export const nameKey = (s: string) => s.normalize("NFKC").replace(/\s/g, "").replace(/^(?:\uC8FC\uC2DD\uD68C\uC0AC|\(\uC8FC\))|(?:\uC8FC\uC2DD\uD68C\uC0AC|\(\uC8FC\))$/g, "");
export const primaryCertificate = (e: LegalEntity) => {
  const id = e.workplaces.find((w) => w.is_primary)?.registration_id;
  return e.registrations.find((r) => r.id === id) ?? (e.registrations.length === 1 ? e.registrations[0] : undefined);
};
/** English shows the English name when set; the short name is a Korean-only alias. */
export const entityNames = (e: Pick<LegalEntity, "current"> | null | undefined) => {
  const name = e?.current?.name ?? "";
  const english = e?.current?.english_name || null;
  if (i18n.locale === "en") return { name: english ?? name, aliases: [] as string[] };
  return { name, aliases: [e?.current?.display_name || null, english].filter((a): a is string => Boolean(a) && a !== name) };
};
/** Canonical display name; call sites should not read `current.name` directly. */
export const entityName = (e: Pick<LegalEntity, "current"> | null | undefined) => entityNames(e).name;
export const legalNameTaken = (name: string, entities: readonly Pick<LegalEntity, "current" | "closed_on">[]) =>
  name.trim() !== "" && entities.some((e) => !e.closed_on && e.current?.name.trim() === name.trim());
/** The server's typed identity problems (one rule, owned by the backend). */
type NameProblem = "legal_name_unconfirmed" | "legal_name_not_hangul" | "legal_name_is_person" | "display_name_is_person" | "english_name_is_person" | "primary_registration_classification" | "legal_name_review";
export const identityProblems = (e: LegalEntity): NameProblem[] => (e.identity_problems ?? []).map((p) => p.code as NameProblem);
const key = (s: string) => s.normalize("NFKC").replace(/\s/g, "");
export function personName(name: string, reps: string[]) {
  const parts = name.split(/[,，、;；/\n·&+]/).map((s) => s.trim()).filter(Boolean);
  return reps.some((r) => r.trim() && key(name) === key(r)) || parts.length > 1 && parts.every((p) => nameKey(p) === key(p) && (/^[\uAC00-\uD7A3\s]+$/u.test(p) || reps.some((r) => key(r) === key(p))));
}
/** An English name: Latin letters, digits, spaces and common corporate punctuation (the server's english_name_not_latin). */
export const latinName = (name: string) => /^[A-Za-z0-9 &.,'()-]*$/.test(name);
