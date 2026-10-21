// The words a close plan's refusals are shown in (UX-R2 ENDS). Pure; copy from the catalogs.
import { isMessageId, t } from "@console/i18n";
import type { ClosePlanView } from "./domain/plan";

/** Why a refused or failed line could not apply, in the user's words (the server's code otherwise). */
export function whyText(code: string) {
  const id = `workplace.close.why.${code}`;
  return isMessageId(id) ? t(id) : t("workplace.close.why.other", { code });
}

/** The name a refusal's subject has on this sheet (a person or a department), or its id. */
export const subjectName = (view: ClosePlanView, r: { employee_id?: string | null; org_unit_id?: string | null }) =>
  view.people.find((p) => p.employee_id === r.employee_id)?.name ?? view.units.find((u) => u.org_unit_id === r.org_unit_id)?.name ?? r.employee_id ?? r.org_unit_id ?? "";
