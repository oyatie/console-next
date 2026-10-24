import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Network } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { get } from "../../../lib/query";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { UnitHistory } from "./unit-history";
import { historyLines } from "../domain/tree";
import { unitsQuery } from "../../../reference/org/api";
import { depts, direct, type Place } from "../../../reference/org/domain/structure";
import { DeptActions } from "./dept-actions";
import { DeptDetails } from "./dept-details";
import { OrderButtons } from "../../../reference/org/ui/order-buttons";
import { Members } from "../../../reference/org/ui/structure-members";
import { CorOnly, Facts, PanelShell, Sec, Stats } from "../../../reference/org/ui/panel-shell";
import { DeptNameInline } from "../../../reference/org/ui/dept-name-inline";
import { RowActions } from "../../../ui/record-actions/record-actions";
import { focusSoon } from "../../../lib/react/announce";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

const route = getRouteApi("/app/org");

/**
 * A department beside the chart (S6-panel). Its legal entity and workplace follow from where it sits and say so; its sub-department and
 * direct members are listed; every action names its consequence.
 */
export function DeptPanel({ place, setup, onClose, as_of, known_at, readOnly = false }: { place: Place; setup: boolean; onClose: () => void; as_of?: string; known_at?: string; readOnly?: boolean }) {
  const navigate = route.useNavigate();
  const n = place.node;
  const detail = useQuery(get("/api/v1/org-units/{id}", { params: { path: { id: n.id } } }));
  const units = useQuery(unitsQuery);
  const revisions = (detail.data?.revisions ?? []).filter((r) => (!as_of || r.effectiveFrom <= as_of) && (!known_at || Date.parse(r.createdAt) <= Date.parse(known_at)));
  const since = revisions.map((r) => r.effectiveFrom).sort()[0];
  const parent = place.parent!;
  const sub = depts(n);
  const select = (id: string) => navigate({ search: (s) => ({ ...s, sel: id, act: undefined }) });
  const [details, setDetails] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // CRUD: head and code are set at once in either phase (PUT …/details; after go-live a governed change).
  const fix = (field: "head" | "code") => !readOnly && (
    <Button variant="ghost" className="btn--sm" id={`act-dept-${field}`} onClick={() => setDetails(true)} aria-label={t("orgStructure.fixOf", { field: t(`orgUnit.fact.${field}`) })}>{t("orgStructure.fix")}</Button>
  );
  const h = n.head;
  return (
    <PanelShell
      crumb={[...place.path, n.name]}
      icon={<Network size={18} aria-hidden />}
      title={n.name}
      chips={<><Chip>{t("orgUnit.kind")}</Chip>{n.code && <span className={css.code}>{n.code}</span>}{as_of && <Chip>{t("orgStructure.asOf", { date: fmtDate(as_of) })}</Chip>}</>}
      anchors={[
        { id: "dept-basic", label: t("orgStructure.tab.basic") },
        ...(!readOnly ? [{ id: "dept-actions", label: t("orgStructure.tab.actions") }] : []),
        { id: "dept-members", label: t("orgUnit.tab.members", { count: n.headcount }) },
        // org-17: the tab counts the lines its list shows (one per change), never raw revisions.
        { id: "dept-history", label: t("orgStructure.tab.history", { count: historyLines(revisions).length }) },
      ]}
      onClose={onClose}
    >
      <Sec id="dept-basic" title={t("orgStructure.tab.basic")}>
        <Stats
          items={[
            { label: t("orgUnit.stat.total"), value: n.headcount },
            { label: t("orgUnit.stat.direct"), value: direct(n) },
            { label: t("orgUnit.stat.sub"), value: sub.length },
            { label: t("orgUnit.fact.head"), value: h?.name ?? t("orgUnit.head.vacant"), name: true },
          ]}
        />
        <Facts
          rows={[
            {
              // The name on its own row with its edit (record-actions §3): in setup typed in place, after go-live a proposal.
              label: t("orgUnit.fact.name"),
              value: !readOnly && renaming ? <DeptNameInline parent={parent} unit={n} onDone={() => setRenaming(false)} /> : n.name,
              act: !readOnly && !renaming && <RowActions field={t("orgUnit.fact.name")} onEdit={() => (setup ? setRenaming(true) : navigate({ search: (x) => ({ ...x, act: "dept-rename" }) }))} path={setup ? "setup" : "approval"} history={() => (document.getElementById("dept-history")?.scrollIntoView({ block: "start" }), focusSoon("dept-history-h"))} />,
            },
            {
              label: t("orgUnit.fact.parent"),
              value: <>{parent.name} <Muted>· {t(parent.kind === "WORKPLACE" ? "orgUnit.fact.underSite" : "orgUnit.fact.underDept")}</Muted></>,
              act: !readOnly && <Button variant="ghost" className="btn--sm" id="act-dept-move" onClick={() => navigate({ to: "/org/move", search: { ids: n.id } })}>{t("orgUnit.act.move")}</Button>,
            },
            { label: t("orgUnit.fact.place"), value: <>{place.entity.name} · {place.workplace?.name} <Muted>{t("orgUnit.fact.derived")}</Muted></> },
            {
              label: t("orgUnit.fact.head"),
              value: h ? <>{h.name}{h.concurrent && ` ${t("orgUnit.head.concurrent")}`}{h.since && <Muted> · {t("orgUnit.head.since", { date: fmtDate(h.since) })}</Muted>}</> : <Muted>{t("orgUnit.head.vacant")}</Muted>,
              act: fix("head"),
            },
            { label: t("orgUnit.fact.code"), value: n.code ? <span className="num">{n.code}</span> : <Muted>{t("orgUnit.code.none")}</Muted>, act: fix("code") },
            { label: t("orgUnit.fact.since"), value: <span className="num">{since ? fmtDate(since) : "—"}</span>, act: !readOnly && <CorOnly /> },
          ]}
        />
        {!readOnly && details && <DeptDetails node={n} onDone={() => setDetails(false)} />}
      </Sec>
      {!readOnly && <Sec id="dept-actions" title={t("orgStructure.tab.actions")}>
        <DeptActions place={place} setup={setup} />
      </Sec>}
      {sub.length > 0 && (
        <Sec id="dept-sub" title={t("orgUnit.sub", { count: sub.length })}>
          <ul className={css.list}>
            {sub.map((c) => (
              <li key={c.id}>
                <Network size={14} aria-hidden />
                <Button variant="ghost" className="btn--sm" onClick={() => select(c.id)}>{c.name}</Button>
                <span className={css.right}>{t("orgStructure.peopleCount", { count: c.headcount })}</span>
                {!readOnly && <OrderButtons parent={n} node={c} kind="DEPARTMENT" />}
              </li>
            ))}
          </ul>
        </Sec>
      )}
      <Sec id="dept-members" title={t("orgUnit.members", { count: direct(n) })}>
        <Members unitId={n.id} total={n.headcount} expected={direct(n)} as_of={as_of} known_at={known_at} />
      </Sec>
      <Sec id="dept-history" title={t("entity.history.title")}>
        {detail.data && <UnitHistory revisions={revisions} units={units.data?.items ?? []} open />}
      </Sec>
    </PanelShell>
  );
}
