// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";

export type PersonIdentity = {
  id: string;
  name?: string | null;
  display_name?: string | null;
  employee_id?: string | null;
  employee_number?: string | null;
  employee_company?: string | null;
  employee_org_unit?: string | null;
  company?: string | null;
  org_unit?: string | null;
  sign_in_id?: string | null;
};

const nameOf = (p: PersonIdentity) => (p.display_name?.trim() || p.name?.trim() || "").normalize("NFC");
const personId = (p: PersonIdentity) => p.employee_id || p.id;
const facts = (p: PersonIdentity) => [p.employee_number, p.employee_company || p.company, p.employee_org_unit || p.org_unit].map((v) => v?.trim()).filter(Boolean).join(" · ");

function detailOf(p: PersonIdentity) {
  const placement = facts(p);
  if (placement) return placement;
  const signIn = p.sign_in_id?.trim();
  const at = signIn?.lastIndexOf("@") ?? -1;
  if (!signIn || at < 1 || at === signIn.length - 1) return p.id;
  const login = signIn.slice(0, at);
  // Keep a useful suffix without revealing short sign-in IDs in full.
  return `${login[0]}••••${login.length > 5 ? login.slice(-4) : ""}${signIn.slice(at)}`;
}

/** One label across account and employee surfaces; a collision retains the stable id, never a private identifier. */
export function personLabel(person: PersonIdentity, peers: readonly PersonIdentity[] = []) {
  const rawName = nameOf(person);
  const name = rawName || t("people.label.unnamed");
  const others = peers.filter((p) => personId(p) !== personId(person) && nameOf(p) === rawName);
  const detail = detailOf(person);
  const distinct = others.some((p) => detailOf(p) === detail) ? `${detail} · ${person.id}` : detail;
  return { name, detail: distinct, text: `${name} · ${distinct}`, sameName: !!rawName && others.length > 0 };
}
