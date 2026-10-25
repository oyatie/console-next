import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { STRUCTURE_READS } from "../../../reference/org/api";
import { governed } from "../api";
import type { GovOp } from "../domain/structure-plans";
import { noteChange } from "../../../reference/org/ui/use-change-note";
import { useOrgRouted } from "./use-org-routed";

export type Govern = { date: string; reason: string };
type Target = { kind: "ORG_UNIT"; ref: string; label: string };

/**
 * The change's own answers: effective date (no default) and reason. Missing ones are named for the foot. Its words follow
 * decisions #26: without approval (`approval.policy.org_structure = none`, the pilot default) a change dated today applies at
 * submit and a later one is recorded for its date; with `route` it is submitted for approval.
 */
export function useGovern() {
  const [g, setG] = useState<Govern>({ date: "", reason: "" });
  const today = todayKst();
  const routed = useOrgRouted();
  const later = Boolean(g.date) && g.date > today;
  const missing = [!g.date && t("orgUnit.gov.missingDate"), !g.reason.trim() && t("orgUnit.gov.missingReason")].filter((x): x is string => Boolean(x));
  const mode = routed ? "route" : later ? "schedule" : "apply";
  return { g, set: (patch: Partial<Govern>) => setG((x) => ({ ...x, ...patch })), today, missing, late: Boolean(g.date) && g.date < today, routed, mode };
}
export type GovernState = ReturnType<typeof useGovern>;

/**
 * One change: its kind, its target (`label` is the change's title, org-25; a creation keeps the new name there, which the
 * list composes, and says its phrase in `title`), its ops, and the unit the chart selects after.
 */
type Body = { kind: "NEW" | "REORG" | "DISSOLVE"; target: Target; proposal: GovOp[]; select?: string; title?: string };

/**
 * Drafts the change (and submits it unless only saved). A submitted change leaves the user on the chart with a receipt
 * that links its record (org-19); a saved draft, or one its preflight blocks, opens its record, where the next step is.
 * One change carries a whole dissolution or merge: the server applies its ops in order (members and sub-units out, then the
 * close), so nothing is split across two changes.
 */
export function useGovernSubmit(build: () => Body, s: GovernState, after?: (out: { id: string; code: string }) => Promise<string | undefined>) {
  const nav = useNavigate();
  return useCommand({
    run: async (submit: boolean, key: string) => {
      const body = build();
      const out = await governed(key, { kind: body.kind, target: body.target, proposal: body.proposal, effectiveDate: s.g.date, reason: s.g.reason.trim() }, submit);
      // What follows a recorded change in another module (a dissolution's grants) runs once it is recorded; its outcome joins the receipt.
      const more = out.sent === "sent" && after ? await after(out) : undefined;
      return { ...out, title: body.title ?? body.target.label, select: out.select ?? body.select ?? body.target.ref, more };
    },
    invalidates: [...STRUCTURE_READS, "/api/v1/org-changes", "/api/v1/employees", "/api/v1/employment-assignments"],
    awaitFirstRead: true,
    onSuccess: (out) => {
      if (out.sent !== "sent") return void nav({ to: "/org/changes/$id", params: { id: out.id }, search: { done: "drafted", unsent: out.sent === "unsent" || undefined } });
      const message =
        s.mode === "route" ? t("orgChange.receipt.routedChart", { title: out.title, code: out.code })
        : s.mode === "schedule" ? t("orgChange.receipt.scheduled", { title: out.title, code: out.code, date: fmtDate(s.g.date) })
        : t("orgChange.receipt.applied", { title: out.title, code: out.code });
      noteChange({ id: out.id, code: out.code, message: [message, out.more].filter(Boolean).join(" · ") });
      void nav({ to: "/org", search: { sel: out.select } });
    },
  });
}
