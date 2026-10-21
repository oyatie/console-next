import { useQuery } from "@tanstack/react-query";
import { i18n } from "@console/i18n";
import { codeText } from "../../../lib/labels";
import { reasonCodesQuery } from "../api";

/** The `role_change` reason codes for a ReasonField: system codes by catalog id, the tenant's own by their label. */
export function useReasons() {
  const q = useQuery(reasonCodesQuery);
  const codes = (q.data?.items ?? [])
    .filter((c) => c.active)
    .map((c) => ({ code: c.code, label: c.system ? codeText(`accessCodes.reason.${c.code}`, c.code) : ((i18n.locale === "en" && c.label_en) || c.label_ko || c.code) }));
  return { codes, failed: q.isError };
}
