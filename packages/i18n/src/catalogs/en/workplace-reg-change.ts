// English source for `workplaceRegChange.` ids (the 사업장 사업자등록 change dialog; split from workplace.ts for the 300-line ceiling).
import type { koWorkplaceRegChange } from "../ko/workplace-reg-change";

export const enWorkplaceRegChange: Record<keyof typeof koWorkplaceRegChange, string> = {
  "workplaceRegChange.action": "Change registration",
  "workplaceRegChange.title": "Change business registration of {name}",
  "workplaceRegChange.kicker": "{entity} · {name}",
  "workplaceRegChange.target": "New registration",
  "workplaceRegChange.from": "Effective date",
  "workplaceRegChange.reason": "Reason",
  "workplaceRegChange.none": "No registration",
  "workplaceRegChange.save": "Change registration",
  "workplaceRegChange.saved": "Changed registration for {name}",
  "workplaceRegChange.same": "Same as current registration. Select another registration or serial.",
  "workplaceRegChange.pickDate": "Enter the effective date.",
  "workplaceRegChange.consequence": "{name} files under the new registration from {date}. Recorded in audit history.",
  "workplaceRegChange.unlinked": "{name} unlinks its business registration from {date}.",
};
