import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { MapPin } from "lucide-react";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { labeled, RECORD_STATUS } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { entityQuery, kindsQuery, workplaceHistoryQuery } from "../api";
import { workplaceName } from "../domain/view";
import { History } from "./history-tab";
import { descendants, direct } from "../../../reference/org/domain/structure";
import type { WorkplacePanelProps } from "../../../reference/org/ui/use-structure-slots";
import { kindName } from "../present";
import { FullIcon, PanelShell, Sec, Stats } from "../../../reference/org/ui/panel-shell";
import { WorkplaceInsurance } from "./workplace-insurance-table";
import { Members } from "../../../reference/org/ui/structure-members";
import { WorkplaceActions } from "./workplace-actions";
import { WorkplaceFacts } from "./workplace-facts";
import { focusSoon } from "../../../lib/react/announce";
import css from "../../../reference/org/ui/structure.module.css";

/** A workplace beside the chart (S5-panel): its numbers, facts with their verbs, social insurance, people, actions and history. */
export function WorkplaceSidePanel({ place, tenant, setup, onClose, onAct }: WorkplacePanelProps) {
  const q = useQuery(entityQuery(place.entity.id));
  return (
    <QueryState q={q}>
      {(e) => {
        const w = e.workplaces.find((x) => x.id === place.node.id);
        return w ? <Body e={e} w={w} place={place} tenant={tenant} setup={setup} onClose={onClose} onAct={onAct} /> : null;
      }}
    </QueryState>
  );
}

function Body({ e, w, place, setup, onClose, onAct }: WorkplacePanelProps & { e: LegalEntity; w: Workplace }) {
  const kinds = useQuery(kindsQuery).data?.items;
  const history = useQuery({ ...workplaceHistoryQuery(w.id), retry: false });
  const n = place.node;
  const name = workplaceName(w);
  const st = labeled(RECORD_STATUS, w.current?.status ?? "CONTINUING");
  const toHistory = () => (document.getElementById("wp-history")?.scrollIntoView({ block: "start" }), focusSoon("wp-history-h"));
  return (
    <PanelShell
      crumb={[...place.path, name]}
      icon={<MapPin size={18} aria-hidden />}
      title={name}
      chips={
        <>
          {w.kind_code && <Chip>{kindName(kinds, w.kind_code)}</Chip>}
          <Chip tone={st.tone}>{st.label}</Chip>
        </>
      }
      open={<Link to="/org/entities/$id" params={{ id: e.id }} search={{ wp: w.id }} className="btn btn--ghost" aria-label={t("orgStructure.openFull", { name })}><FullIcon /></Link>}
      anchors={[
        { id: "wp-basic", label: t("orgStructure.tab.basic") },
        { id: "wp-insurance", label: t("workplace.field.insurance") },
        { id: "wp-actions", label: t("orgStructure.tab.actions") },
        { id: "wp-people", label: t("orgStructure.tab.people") },
        { id: "wp-history", label: t("orgStructure.tab.history", { count: history.data?.items.length ?? 0 }) },
      ]}
      onClose={onClose}
    >
      <Sec id="wp-basic" title={t("orgStructure.tab.basic")}>
        <Stats
          items={[
            { label: t("orgStructure.stat.people"), value: n.headcount },
            { label: t("orgStructure.stat.siteDirect"), value: direct(n) },
            { label: t("orgStructure.stat.depts"), value: descendants(n).length },
          ]}
        />
        <WorkplaceFacts e={e} w={w} place={place} onAct={onAct} onHistory={toHistory} />
        {e.biz_kind === "CORPORATION" && <p className={css.note}>{t("workplace.edit.withholdingNote")}</p>}
      </Sec>
      <Sec id="wp-insurance" title={t("orgStructure.wp.insurance")}>
        <WorkplaceInsurance e={e} w={w} onHistory={toHistory} />
      </Sec>
      <Sec id="wp-actions" title={t("orgStructure.tab.actions")}>
        {w.can_manage ? <WorkplaceActions place={place} setup={setup} onAct={onAct} /> : <p className="muted">{t("entityOps.lock.reachWorkplace")}</p>}
      </Sec>
      <Sec id="wp-people" title={t("orgStructure.wp.people", { count: direct(n) })}>
        <Members unitId={n.org_unit_id} total={n.headcount} expected={direct(n)} />
      </Sec>
      <Sec id="wp-history" title={t("entity.history.title")}>
        <History target={{ id: e.id, wp: w.id }} q={history} subject={name} known={w.current ? [w.current] : []} />
      </Sec>
    </PanelShell>
  );
}
