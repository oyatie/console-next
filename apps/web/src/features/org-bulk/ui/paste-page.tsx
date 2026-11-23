import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { QueryState } from "../../../lib/react/query-state";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { structureQuery } from "../api";
import { type PlanRoot } from "../domain/plan";
import { BulkHead } from "./bulk-head";
import { findRoot, usePasteEditor } from "./paste-parts";
import { PickRoot } from "./paste-pick-root";
import s from "./bulk.module.css";

const route = getRouteApi("/app/org/paste");
const PasteConsole = lazy(() => chunk(import("./paste-console")).then((m) => ({ default: m.PasteConsole })));

/** S7 paste a list: a full page under one legal entity (`?entity=`) or one workplace (`?workplace=`); without one it asks where. */
export function PastePage() {
  return <AccessGate domain="org" level="edit"><PasteWorkspace /></AccessGate>;
}

function PasteWorkspace() {
  return (
    <ExperienceSwitch baseline={() => <PasteBaseline />}>
      {() => <Suspense fallback={<ReadSkeleton layout="form" />}><PasteConsole /></Suspense>}
    </ExperienceSwitch>
  );
}

function PasteBaseline() {
  const { entity, workplace } = route.useSearch();
  const tree = useQuery(structureQuery);
  const at = findRoot(tree.data?.entities ?? [], entity, workplace);
  const under = at && tree.data?.phase !== "OPERATING" ? at.root.kind === "entity" ? t("orgBulk.paste.under.entity", { entity: at.root.node.name }) : t("orgBulk.paste.under.workplace", { workplace: at.root.node.name }) : undefined;
  return (
    <div className={s.frame}>
      <BulkHead title={t("orgBulk.paste.title")} under={under} />
      <QueryState q={tree} layout="grid">
        {(d) => {
          const ents = d.entities.filter((e) => e.kind === "LEGAL_ENTITY");
          if (ents.length === 0) return <PickRoot entities={ents} />;
          if (d.phase === "OPERATING") {
            const target = at?.root.kind === "workplace" ? at.root.node : (at?.owner.children ?? ents.flatMap((e) => e.children)).find((n) => n.kind === "WORKPLACE");
            return <EmptyState title={t("orgBulk.operating")} reason={null} actions={<Link to="/org" search={{ sel: target?.id, act: "dept-add" }} className={buttonClass("primary")}>{t("orgBulk.operating.action")}</Link>} />;
          }
          return at ? <PasteEditor key={at.root.node.id} root={at.root} entity={at.owner} /> : <PickRoot entities={ents} />;
        }}
      </QueryState>
    </div>
  );
}

function PasteEditor({ root, entity }: { root: PlanRoot; entity: Node }) {
  const ed = usePasteEditor({ root, entity });
  if (ed.done) return <div className={s.body}>{ed.receiptView}</div>;
  return (
    <>
      <div className={`${s.body} ${s.cols3}`}>
        {ed.inputSection}
        {ed.planSection}
        {ed.railSection(false)}
      </div>
      <footer className={s.foot}>
        <p className={s.footText} data-tone={ed.can || ed.planLength === 0 ? undefined : "warn"} id="paste-foot">{ed.foot}</p>
        {ed.noticeView}
        {ed.submitActions(buttonClass())}
      </footer>
    </>
  );
}
