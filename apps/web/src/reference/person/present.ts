// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";

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
  created_at?: string | null;
};

/** A person name stays visible even for an account whose name has not been set. */
export const personName = (name?: string | null, fallback = t("account.name.unset")) => name?.trim().normalize("NFC") || fallback;

const nameOf = (p: PersonIdentity) => (p.display_name?.trim() || p.name?.trim() || "").normalize("NFC");
const personId = (p: PersonIdentity) => p.employee_id || p.id;
const facts = (p: PersonIdentity) => [p.employee_number, p.employee_company || p.company, p.employee_org_unit || p.org_unit].map((v) => v?.trim()).filter(Boolean).join(" · ");

function signInDetail(p: PersonIdentity, expanded = false) {
  const signIn = p.sign_in_id?.trim();
  const at = signIn?.lastIndexOf("@") ?? -1;
  if (!signIn || at < 1 || at === signIn.length - 1) return t("people.label.identityMissing");
  const login = signIn.slice(0, at);
  const mask = "••••";
  // Colliding masks share their first character; hide it while exposing the distinguishing remainder.
  if (expanded) return `${mask}${signIn.slice(1)}`;
  // Keep a useful suffix without revealing short sign-in IDs in full.
  return `${login[0]}${mask}${login.length > 5 ? login.slice(-4) : ""}${signIn.slice(at)}`;
}

const detailOf = (p: PersonIdentity) => facts(p) || signInDetail(p);
type CollisionGroup = { ids: Set<string>; groups: Map<string, CollisionGroup> };
const peerIndexes = new WeakMap<readonly PersonIdentity[], { locale: string; groups: Map<string, CollisionGroup> }>();

/** Query snapshots are immutable: group once per array, rather than scanning every peer for every row. */
function collisionIndex(peers: readonly PersonIdentity[]) {
  const cached = peerIndexes.get(peers);
  if (cached?.locale === i18n.locale) return cached.groups;
  const groups = new Map<string, CollisionGroup>();
  for (const p of peers) {
    let level = groups;
    for (const key of [nameOf(p), detailOf(p), p.created_at ? fmtDateTime(p.created_at) : "", signInDetail(p)]) {
      let group = level.get(key);
      if (!group) { group = { ids: new Set(), groups: new Map() }; level.set(key, group); }
      group.ids.add(personId(p));
      level = group.groups;
    }
  }
  peerIndexes.set(peers, { locale: i18n.locale, groups });
  return groups;
}

const hasOther = (group: CollisionGroup | undefined, id: string) => !!group && group.ids.size > (group.ids.has(id) ? 1 : 0);

/** One label across account and employee surfaces; missing human identifiers never fall back to account UUIDs. */
export function personLabel(person: PersonIdentity, peers: readonly PersonIdentity[] = []) {
  const rawName = nameOf(person);
  const name = personName(rawName, t("people.label.unnamed"));
  const id = personId(person);
  const names = collisionIndex(peers).get(rawName);
  const sameName = !!rawName && hasOther(names, id);
  const identity = detailOf(person);
  const details = names?.groups.get(identity);
  let detail = identity;
  if (sameName && person.display_name != null && person.created_at && hasOther(details, id)) {
    const at = fmtDateTime(person.created_at);
    detail = t("people.label.accountCreated", { at });
    const created = details?.groups.get(at);
    if (hasOther(created, id)) {
      const mask = signInDetail(person);
      detail += ` · ${signInDetail(person, hasOther(created?.groups.get(mask), id))}`;
    }
  }
  return { name, detail, text: `${name} · ${detail}`, sameName };
}
