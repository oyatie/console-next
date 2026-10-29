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
  "empContact.basis.VITAL_INTEREST_PENDING_COUNSEL": "Emergency response",
  "empContact.basis.unknown": "Check processing basis",
  "empContact.basis.label": "검토 전",
  "empContact.basis.notice": "Basis: emergency response (검토 전 · pending counsel, not consent)",
  "empContact.notice.label": "Contact notice confirmation",
  "empContact.notice.unconfirmed": "Contact notice unconfirmed",
  "empContact.notice.confirm": "Confirmed that the employee told this contact person that their details are recorded (검토 전)",
  "empContact.need.notice": "Confirm that the contact person was told",
  "empContact.recorded": "Basis {basis} ({label}) · Recorded by {by} · {at}",
  "empContact.of": "emergency contact {who}",
};
