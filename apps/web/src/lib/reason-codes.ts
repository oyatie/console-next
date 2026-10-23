// BW-07 reason codes: the server's list per domain (system codes first, then the tenant's, then OTHER), labelled
// from the catalog (`reason.<domain>.<code>`) for system codes and from the row for a tenant's own codes.
import type { components } from "@console/api/schema";
import { i18n, isMessageId, t } from "@console/i18n";
import { useQuery } from "@tanstack/react-query";
import { get } from "./query";

type Entry = components["schemas"]["ReasonCatalogEntry"];
export type ReasonDomain = "registration_void" | "lifecycle_transfer" | "lifecycle_promote" | "lifecycle_cancel" | "period_lock" | "period_unlock" | "exception" | "rrn_reveal" | "employee_number_change" | "exit_reason" | "sign_in_id_change";
export type ReasonOption = { value: string; label: string; requiresNote: boolean };

export const reasonCodesQuery = (domain: ReasonDomain) => ({ ...get("/api/v1/reason-codes", { params: { query: { domain } } }), staleTime: 5 * 60_000 });

/** A code's words: the catalog's for a system code, the tenant's own label otherwise, else the code itself (drift stays visible). */
export function reasonLabel(domain: ReasonDomain, code: string, entry?: Pick<Entry, "system" | "label_ko" | "label_en">) {
  const id = `reason.${domain}.${code}`;
  if (entry && !entry.system) return (i18n.locale === "ko" ? entry.label_ko : entry.label_en) ?? entry.label_ko ?? code;
  return isMessageId(id) ? t(id) : code;
}

/** The codes a new record may take (inactive ones stay readable in history only), in the server's order. */
export const reasonOptions = (domain: ReasonDomain, items: readonly Entry[] | undefined): ReasonOption[] =>
  (items ?? []).filter((e) => e.active).map((e) => ({ value: e.code, label: reasonLabel(domain, e.code, e), requiresNote: e.requires_note }));

/** Whether `code` needs a written note (OTHER, or a tenant code marked so). */
export const useNeedsNote = (domain: ReasonDomain, code: string | null) =>
  reasonOptions(domain, useQuery(reasonCodesQuery(domain)).data?.items).some((o) => o.value === code && o.requiresNote);

/**
 * Whether the domain's list loaded with a code to pick: only then is a code asked for. Where the server takes a
 * command without one (a transfer, a promotion, a lock with a note), an unavailable list degrades to the note alone.
 */
export const useReasonCodesReady = (domain: ReasonDomain | null) => {
  const q = useQuery({ ...reasonCodesQuery(domain ?? "lifecycle_cancel"), enabled: domain !== null });
  return domain !== null && q.isSuccess && reasonOptions(domain, q.data.items).length > 0;
};


/** The selected reason reference owns its class; callers never maintain their own code lists. */
export const useExitClass = (code: string | null) =>
  useQuery(reasonCodesQuery("exit_reason")).data?.items.find((e) => e.code === code);
