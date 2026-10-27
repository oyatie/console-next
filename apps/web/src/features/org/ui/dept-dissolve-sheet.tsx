import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Lock, Network, UserX } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { get } from "../../../lib/query";
import { CommandError } from "../../../lib/react/command-error";
import { Composer } from "../../../ui/composer/composer";
import { depts, type Node, type Place } from "../../../reference/org/domain/structure";
import { grantsQuery, settleGrants } from "../api";
import { defaultDestination, dissolvePlan, scopedGrants, type GrantChoice, type Member } from "../domain/dissolve-plan";
import { DissolveGrants } from "./dissolve-grants";
import { DissolveMembers } from "./dissolve-members";
import { GovernFields } from "./govern-fields";
import { useGovern, useGovernSubmit } from "./use-govern";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * One dissolution sheet after go-live (org-06, org-31): what must be decided comes first — where the members go (everyone to
 * one place, any one elsewhere), the sub-department (up one level), the grants scoped here (re-point or end, a required
 * choice) and the head post (vacant from then) — then the date and reason, then one sentence of consequence. It is
 * one change: the server moves the people (a dated transfer each) and sub-department first, then closes the unit, and the
 * user stays on the chart with a receipt. Kept in the history, never deleted.
 */
export function DeptDissolveSheet({ place, places, company, onClose }: { place: Place; places: Map<string, Place>; company: string; onClose: () => void }) {
  const d = place.node;
  const sub = depts(d);
  const detail = useQuery(get("/api/v1/org-units/{id}", { params: { path: { id: d.id } } }));
  const access = useQuery(grantsQuery);
  const members: Member[] = (detail.data?.members.items ?? []).map((m) => ({ employeeId: m.employeeId, name: m.name }));
  const defaultTo = defaultDestination(place);
  const [toId, setTo] = useState(defaultTo.id);
  const [overrides, setOverrides] = useState(new Map<string, Node>());
  const [choices, setChoices] = useState(new Map<string, GrantChoice>());
  const gov = useGovern();
  const to = places.get(toId)?.node ?? defaultTo;
  const grants = scopedGrants(access.data?.items ?? [], d.id);
  const workplaceOf = (n: Node) => places.get(n.id)?.workplace?.id;
  const workplaceName = (n: Node) => places.get(n.id)?.workplace?.name;
  const plan = dissolvePlan({ place, members, to, overrides, grants, choices, company, date: gov.g.date || gov.today, today: gov.today, workplaceOf });
  const title = t("orgChange.title.dissolve", { name: d.name });
  const toName = to.kind === "WORKPLACE" ? t("orgUnit.dissolve.siteDirect", { site: to.name }) : to.name;
  const submit = useGovernSubmit(
    () => ({ kind: "DISSOLVE", target: { kind: "ORG_UNIT", ref: d.id, label: title }, proposal: plan.ops, select: place.parent?.id }),
    gov,
    async () => {
      if (plan.grantOps.length === 0) return undefined;
      try {
        const out = await settleGrants({ operations: plan.grantOps, reason_code: "ACCESS_CLEANUP", reason_note: title });
        return out === "done" ? t("orgUnit.dissolve.grantsDone", { count: grants.length }) : t("orgUnit.dissolve.grantsLeft", { count: grants.length });
      } catch {
        return t("orgUnit.dissolve.grantsLeft", { count: grants.length });
      }
    },
  );
  const open = [
    detail.isPending && t("orgUnit.dissolve.loading"),
    plan.grantsOpen > 0 && t("orgUnit.dissolve.grantsOpen", { count: plan.grantsOpen }),
    ...gov.missing,
  ].filter((x): x is string => Boolean(x));
  const reasonId = "dept-dissolve-reason";
  const head = d.head;
  return (
    <Composer
      size="lg"
      kicker={<><Network size={14} aria-hidden />{[...place.path, d.name].join(" › ")}</>}
      title={title}
      onClose={onClose}
      pending={submit.isPending}
      notice={<CommandError error={submit.error} />}
      consequence={
        open.length ? (
          <span id={reasonId} className={css.footReason}><Lock size={14} aria-hidden />{t("orgUnit.gov.missing", { list: open.join(", ") })}</span>
        ) : (
          <>
            <span>{t("orgUnit.dissolve.consequence", { name: d.name, date: fmtDate(gov.g.date), n: members.length, sub: sub.length })}</span>
            <Muted>{plan.sitesMoved ? t("orgUnit.dissolve.siteChange", { n: plan.sitesMoved }) : t("orgUnit.dissolve.noSiteChange")}</Muted>
          </>
        )
      }
      action={{ kind: "orgDissolve", mode: gov.routed ? "request" : gov.mode === "schedule" ? "schedule" : "apply", count: 1 }}
      sections={{ approvals: gov.routed ? t("orgPropose.route") : null }}
      onSubmit={() => { if (open.length === 0) submit.mutate(true); }}
      blocked={open.length ? { reason: open.join(", ") } : undefined}
      onSaveDraft={open.length === 0 ? () => submit.mutate(false) : undefined}
      tone="danger"
    >
      <section className={css.stack} aria-labelledby="dissolve-first">
        <h3 id="dissolve-first" className="field__label">{t("orgUnit.dissolve.first")}</h3>
        {members.length > 0 && (
          <DissolveMembers
            place={place}
            groups={plan.groups}
            to={to}
            onTo={setTo}
            overrides={overrides}
            onOverride={(m, id) => setOverrides((x) => { const n = new Map(x); const node = id ? places.get(id)?.node : undefined; if (node && node.id !== to.id) n.set(m.employeeId, node); else n.delete(m.employeeId); return n; })}
            workplaceName={workplaceName}
          />
        )}
        {members.length === 0 && !detail.isPending && <p className="row"><Check size={14} aria-hidden />{t("orgUnit.dissolve.noMembers")}</p>}
        {sub.length > 0 && <p className="row"><Check size={14} aria-hidden />{t("orgUnit.dissolve.subPlan", { list: sub.map((c) => c.name).join(" · "), parent: place.parent!.name })}</p>}
        <p className="row"><UserX size={14} aria-hidden />{head ? t("orgUnit.dissolve.headVacant", { name: head.name }) : t("orgUnit.dissolve.noHead")}</p>
        <h4 className="field__label">{t("orgUnit.dissolve.grants")}</h4>
        <DissolveGrants grants={grants} choices={choices} onChoose={(id, c) => setChoices((x) => new Map(x).set(id, c))} toName={toName} unreadable={access.isError} />
      </section>
      <GovernFields s={gov} />
      <p className={css.note}>{t("orgUnit.dissolve.kept")}</p>
    </Composer>
  );
}
