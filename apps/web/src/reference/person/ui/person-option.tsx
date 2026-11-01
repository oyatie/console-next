// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { PickerOption } from "../../../ui/server-picker/server-picker";
import { personLabel, type PersonIdentity } from "../present";
import { PersonLabel } from "./person-label";

/** Listbox options stay noninteractive; the chosen person's label can link to their record. */
export function personOption(person: PersonIdentity, peers: readonly PersonIdentity[]): PickerOption {
  const label = personLabel(person, peers);
  const collides = person.display_name != null && label.sameName && peers.some((p) => p.id !== person.id && personLabel(p).text === label.text);
  return { id: person.id, name: label.name, code: person.employee_number?.trim() || undefined, display: <PersonLabel person={person} peers={peers} linked={false} />,
    context: collides && person.created_at ? t("people.label.accountCreated", { at: fmtDateTime(person.created_at) }) : undefined };
}
