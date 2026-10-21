import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { label, UNIT_KIND } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { rollupHeadcount, unitPath } from "../../../reference/org/present";
import { draftChange, me } from "../api";
import { childrenOf, EMPTY, namesakes, type Field, type Unit, type Values } from "../domain/proposal";
import type { Check } from "./propose-shell";

type Summary = components["schemas"]["OrgChangeSummary"];
type Body = components["schemas"]["CreateOrgChangeRequest"];
type Op = components["schemas"]["OrgProposalOp"];

export const kindName = (k: Unit["kind"]) => label(UNIT_KIND, k);

/** A card's consequence: what starts on submit, then `middle`, then that nothing applies by itself and nothing is withdrawn. */
export const consequenceOf = (date: string, middle?: string, routed = true) =>
  (routed
    ? [date ? t("orgPropose.consequence.start", { date: fmtDate(date) }) : t("orgPropose.consequence.startNoDate"), middle, t("orgPropose.consequence.manual"), t("orgPropose.consequence.final")]
    : // decisions #26: no approval by default; today's change applies at submit, a later one waits for its effective date.
      [date && date > todayKst() ? t("orgPropose.consequence.directDated", { date: fmtDate(date) }) : t("orgPropose.consequence.direct"), middle, t("orgPropose.consequence.directUndo")]
  )
    .filter(Boolean)
    .join(" ");

/** The checks, or one line saying nothing known stands in the way. */
export const okOr = (checks: Check[]): Check[] => (checks.length ? checks : [{ tone: "ok", text: t("orgPropose.checks.none") }]);

/**
 * What the unit intents share: lookups over today's tree, the open changes, and the one-write draft.
 * `skip` is an open change the card already names (a member move shown with its dissolve).
 */
export function unitKit(units: Unit[], v: Values, open: Summary[], skip?: string, routed = true) {
  const counts = rollupHeadcount(units);
  const name = v.name.trim();
  const kids = (u: Unit) => childrenOf(units, u.id);
  // My newest unsubmitted structural draft (the list is newest first). A dissolve is its own kind: it applies at
  // archive, after settlement, so nothing else joins it and it joins nothing.
  const mine = open.find((c) => (c.status === "DRAFT" || c.status === "PRECHECKED") && (c.kind === "NEW" || c.kind === "REORG") && c.target.kind === "ORG_UNIT" && c.draftedBy === me());
  return {
    name,
    company: units.find((u) => u.kind === "COMPANY"),
    byId: (id: string | null | undefined) => units.find((u) => u.id === id),
    // The root unit is "All", never the account's name (decision #29).
    path: (u: Unit) => (u.kind === "COMPANY" ? label(UNIT_KIND, u.kind) : unitPath(units, u)),
    kids,
    kidNames: (u: Unit) => kids(u).map((k) => k.name).join(", ") || t("orgPropose.ctx.none"),
    rollup: (u: Unit) => counts.get(u.id) ?? u.headcount,
    then: v.date ? t("orgPropose.diff.then", { date: fmtDate(v.date) }) : t("orgPropose.diff.thenNoDate"),
    consequence: (middle?: string) => consequenceOf(v.date, middle, routed),
    headcountNote: t("orgPropose.ctx.headcountNote"),
    /** Open changes already on this unit: a caution, the server does not refuse a second one yet. */
    onTarget: (u: Unit) => open.filter((c) => c.target.kind === "ORG_UNIT" && c.target.ref === u.id && c.id !== skip),
    /** A unit among `siblings` (under `parentId`) with the typed name, else an open create there or a rename using it. */
    namesake: (siblings: Unit[], parentId: string) => ({
      unit: namesakes(name, siblings)[0],
      change: open.find(
        (c) => c.target.kind === "ORG_UNIT" && (c.kind === "NEW" ? c.target.ref === parentId : c.kind === "REORG") && namesakes(name, [{ name: c.target.label }]).length > 0,
      ),
    }),
    /** `op` may join my open draft instead of starting its own approval. */
    into: (op: Op) => (mine ? { into: mine, op } : undefined),
    /** One write (D17): the change carries its date and reason. */
    post: (key: string, body: Omit<Body, "effectiveDate" | "reason">) => draftChange(key, { ...body, effectiveDate: v.date, reason: v.reason.trim() }),
  };
}
export type UnitKit = ReturnType<typeof unitKit>;

/** One card's typed values, all empty at first: nothing is preselected. */
export function useValues() {
  const { as_of } = useSearch({ strict: false });
  const [v, setV] = useState<Values>(() => ({ ...EMPTY, date: as_of && as_of > todayKst() ? as_of : "" }));
  return [v, (f: Field, x: string) => setV((s) => ({ ...s, [f]: x }))] as const;
}
