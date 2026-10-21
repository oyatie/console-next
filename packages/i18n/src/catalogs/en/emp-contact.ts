// English for `empContact.` ids.
import type { koEmpContact } from "../ko/emp-contact";

export const enEmpContact: Partial<Record<keyof typeof koEmpContact, string>> = {
  "empContact.add": "Add emergency contact",
  "empContact.edit": "Edit emergency contact",
  "empContact.added": "Emergency contact added",
  "empContact.saved": "Emergency contact saved",
  "empContact.full": "Up to {max} are kept · delete or edit one",
  "empContact.name": "Name",
  "empContact.relation": "Relation",
  "empContact.relation.pick": "Choose a relation",
  "empContact.phone": "Mobile",
  "empContact.need.name": "Enter a name",
  "empContact.need.relation": "Choose a relation",
  "empContact.need.phone": "Enter a mobile number",
  "empContact.of": "emergency contact {who}",
};
