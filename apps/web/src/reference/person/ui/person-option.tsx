// SPDX-License-Identifier: LicenseRef-Proprietary
import type { PickerOption } from "../../../ui/server-picker/server-picker";
import { personLabel, type PersonIdentity } from "../present";
import { PersonLabel } from "./person-label";

/** Listbox options stay noninteractive; the chosen person's label can link to their record. */
export function personOption(person: PersonIdentity, peers: readonly PersonIdentity[]): PickerOption {
  return { id: person.id, name: personLabel(person, peers).name, code: person.employee_number?.trim() || undefined, display: <PersonLabel person={person} peers={peers} linked={false} /> };
}
