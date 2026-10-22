// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import { personLabel, type PersonIdentity } from "../present";
import s from "./person-label.module.css";

export function PersonLabel({ person, peers }: { person: PersonIdentity; peers?: readonly PersonIdentity[] }) {
  const label = personLabel(person, peers);
  return <bdi className={s.label} title={label.text}>
    <bdi className={s.name}>{label.name}{label.sameName && <Chip>{t("people.sameName.chip")}</Chip>}</bdi>
    <bdi className={s.detail}>{label.detail}</bdi>
  </bdi>;
}
