// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Link } from "@tanstack/react-router";
import { Chip } from "../../../ui/chip";
import { personLabel, type PersonIdentity } from "../present";
import s from "./person-label.module.css";

export function PersonLabel({ person, peers, linked = true }: { person: PersonIdentity; peers?: readonly PersonIdentity[]; linked?: boolean }) {
  const label = personLabel(person, peers);
  const content = <bdi className={s.label} title={label.text}>
    <bdi className={s.name}><bdi className={s.text}>{label.name}</bdi>{label.sameName && <Chip>{t("people.sameName.chip")}</Chip>}</bdi>
    <bdi className={`${s.detail} t-xs muted`}>{label.detail}</bdi>
  </bdi>;
  return linked && person.employee_id ? <Link to="/people/$id" params={{ id: person.employee_id }}>{content}</Link> : content;
}

/** A separate person-card action beside an existing account-access link, without nested links. */
export function PersonRecordLink({ person, peers }: { person: PersonIdentity; peers?: readonly PersonIdentity[] }) {
  return person.employee_id && <Link to="/people/$id" params={{ id: person.employee_id }} aria-label={t("people.label.record", { name: personLabel(person, peers).text })}>{t("peopleJump.keys.group.card")}</Link>;
}
