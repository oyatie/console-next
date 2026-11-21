// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { structureQuery } from "../api";
import type { PlanRoot } from "../domain/plan";
import { findRoot, usePasteEditor } from "./paste-parts";
import { PickRoot } from "./paste-pick-root";
import s from "./bulk.module.css";

const route = getRouteApi("/app/org/paste");

const pasteHead = (under?: string) => ({
  title: t("orgBulk.paste.title"),
  crumbs: <Crumbs items={[<Link key="org" to="/org">{t("orgStructure.title")}</Link>]} current={t("orgBulk.paste.title")} />,
  meta: under ? <bdi>{under}</bdi> : undefined,
  actions: (
    <Link to="/org" search={{}} className={buttonClass("ghost", { icon: true })} aria-label={t("orgBulk.close")}>
      <X size={16} aria-hidden />
    </Link>
  ),
});

export function PasteConsole() {
  const { entity, workplace } = route.useSearch();
  const tree = useQuery(structureQuery);
  const ents = (tree.data?.entities ?? []).filter((e) => e.kind === "LEGAL_ENTITY");
  const at = findRoot(tree.data?.entities ?? [], entity, workplace);
  const under = at && tree.data?.phase !== "OPERATING"
    ? at.root.kind === "entity"
      ? t("orgBulk.paste.under.entity", { entity: at.root.node.name })
      : t("orgBulk.paste.under.workplace", { workplace: at.root.node.name })
    : undefined;

  if (tree.data && ents.length > 0 && tree.data.phase !== "OPERATING" && at) {
    return <PasteConsoleEditor key={at.root.node.id} tree={tree} root={at.root} entity={at.owner} under={under} />;
  }

  return (
    <WizardPattern
      q={tree}
      head={pasteHead(under)}
      body={
        tree.data ? (
          ents.length === 0 ? (
            <PickRoot entities={ents} />
          ) : tree.data.phase === "OPERATING" ? (
            <EmptyState
              title={t("orgBulk.operating")}
              reason={null}
              actions={
                <Link
                  to="/org"
                  search={{
                    sel: (at?.root.kind === "workplace" ? at.root.node : (at?.owner.children ?? ents.flatMap((e) => e.children)).find((n) => n.kind === "WORKPLACE"))?.id,
                    act: "dept-add",
                  }}
                  className={buttonClass("primary")}
                >
                  {t("orgBulk.operating.action")}
                </Link>
              }
            />
          ) : (
            <PickRoot entities={ents} />
          )
        ) : null
      }
      actions={null}
    />
  );
}

function PasteConsoleEditor({
  tree,
  root,
  entity,
  under,
}: {
  tree: ReturnType<typeof useQuery<Awaited<ReturnType<typeof structureQuery.queryFn>>>>;
  root: PlanRoot;
  entity: Node;
  under?: string;
}) {
  const ed = usePasteEditor({ root, entity });
  return (
    <WizardPattern
      q={tree}
      head={pasteHead(under)}
      body={
        ed.done ? (
          ed.receiptView
        ) : (
          <div className={`${s.body} ${s.cols2}`}>
            {ed.inputSection}
            {ed.planSection}
          </div>
        )
      }
      asideLabel={t("orgBulk.summary.title")}
      aside={!ed.done ? ed.railSection(true) : undefined}
      notice={!ed.done ? ed.noticeView : undefined}
      consequence={
        !ed.done ? (
          <bdi className={s.footText} data-tone={ed.can || ed.planLength === 0 ? undefined : "warn"} id="paste-foot">
            {ed.foot}
          </bdi>
        ) : undefined
      }
      actions={!ed.done ? ed.submitActions() : null}
    />
  );
}
