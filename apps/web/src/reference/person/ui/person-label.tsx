// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Link } from "@tanstack/react-router";
import { Chip } from "../../../ui/chip";
import { personLabel, type PersonIdentity } from "../present";
import s from "./person-label.module.css";

export function PersonLabel({ person, peers, linked = true, wrap = false, details = true }: { person: PersonIdentity; peers?: readonly PersonIdentity[]; linked?: boolean; wrap?: boolean; details?: boolean }) {
  const label = personLabel(person, peers);
  const content = <bdi className={`${s.label} ${wrap ? s.wrap : ""}`} title={label.text}>
    <bdi className={s.name}><bdi className={s.text}>{label.name}</bdi>{label.sameName && <Chip>{t("people.sameName.chip")}</Chip>}</bdi>
    {details && <bdi className={`${s.detail} t-xs muted`}>{label.detail}</bdi>}
  </bdi>;
  return linked && person.employee_id ? <Link to="/people/$id" params={{ id: person.employee_id }}>{content}</Link> : content;
}

/** An account's linked employee keeps the person's name and placement, separately from the account name. */
export function PersonRef({ account, wrap = false, details = true }: { account: PersonIdentity & { employee_name?: string | null }; wrap?: boolean; details?: boolean }) {
  return account.employee_id ? <PersonLabel wrap={wrap} details={details} person={{
    id: account.employee_id, employee_id: account.employee_id, name: account.employee_name,
    employee_number: account.employee_number, company: account.employee_company, org_unit: account.employee_org_unit,
  }} /> : null;
}

/** A separate person-card action beside an existing account-access link, without nested links. */
export function PersonRecordLink({ person, peers }: { person: PersonIdentity; peers?: readonly PersonIdentity[] }) {
  return person.employee_id && <Link to="/people/$id" params={{ id: person.employee_id }} aria-label={t("people.label.record", { name: personLabel(person, peers).text })}>{t("peopleJump.keys.group.card")}</Link>;
}
