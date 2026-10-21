import { Building2, TriangleAlert } from "lucide-react";
import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import { entityPrefix, type ImportPlan } from "../domain/import-plan";
import { emptyAnswers, wpRef, type SiteAnswers } from "../domain/ops";
import { planCounts } from "../domain/plan";
import { PlanList } from "./plan-list";
import { SiteCard } from "./site-card";
import s from "./bulk.module.css";

/** Every existing department under a legal entity (the ones a file does not name stay as they are). */
const deptCount = (n: { kind: string; children: readonly { kind: string; children: readonly unknown[] }[] }): number =>
  n.children.reduce((sum, c) => sum + (c.kind === "DEPARTMENT" || c.kind === "TEAM" ? 1 : 0) + deptCount(c as typeof n), 0);

/**
 * S7 preview: the row funnel, the new workplaces' questions first (nothing preselected), the rows with errors, and per
 * legal entity the tree the import would leave — linked, new, in text (D16). Nothing outside the file is touched.
 */
export function ImportPreview({ plan, answers, onAnswer }: { plan: ImportPlan; answers: Record<string, SiteAnswers>; onAnswer: (ref: string, a: SiteAnswers) => void }) {
  const sum = plan.byEntity.map((b) => planCounts(b.rows)).reduce((a, c) => ({ workplaces: a.workplaces + c.workplaces, depts: a.depts + c.depts, links: a.links + c.links, fix: 0 }), { workplaces: 0, depts: 0, links: 0, fix: 0 });
  const untouched = plan.byEntity.reduce((n, b) => n + deptCount(b.entity) - b.rows.filter((r) => r.status === "link" && r.level === "dept").length, 0);
  return (
    <div className={`${s.body} ${s.cols2}`}>
      <section className={s.col} aria-labelledby="preview-tree">
        <h2 id="preview-tree" className={s.colHead}>{t("orgBulk.plan.title")}</h2>
        {plan.byEntity.map((b, i) => (
          <div key={b.entity.id}>
            <h3 className={s.entityHead}>
              <Building2 size={16} aria-hidden /> {b.entity.name}
              <span className={s.legend}>{t("orgBulk.import.entityCounts", { sites: planCounts(b.rows).workplaces, depts: planCounts(b.rows).depts, links: planCounts(b.rows).links })}</span>
            </h3>
            <PlanList rows={b.rows} names={{}} onRename={() => undefined} rootName={b.entity.name} levelOffset={0} key={entityPrefix(i)} />
          </div>
        ))}
        {untouched > 0 && <p className={s.note}>{t("orgBulk.import.untouched", { count: untouched })}</p>}
      </section>
      <aside className={s.rail}>
        <section className={`card ${s.card}`} aria-labelledby="funnel">
          <h2 id="funnel" className={s.cardHead}>{t("orgBulk.import.preview", { rows: plan.lines.total })}</h2>
          <p className={s.funnel}>{t("orgBulk.import.funnel", { total: plan.lines.total, apply: plan.lines.apply, error: plan.lines.error, skipped: plan.lines.skipped })}</p>
          <div className={s.chips}>
            <Chip tone="ok">{t("orgBulk.import.count.newSites", { count: sum.workplaces })}</Chip>
            <Chip tone="ok">{t("orgBulk.import.count.newDepts", { count: sum.depts })}</Chip>
            <Chip>{t("orgBulk.import.count.linked", { count: sum.links })}</Chip>
            {plan.errors.length > 0 && <Chip tone="danger">{t("orgBulk.import.count.errors", { count: plan.errors.length })}</Chip>}
          </div>
        </section>
        {plan.byEntity.flatMap((b, i) =>
          b.rows
            .filter((r) => r.level === "workplace" && r.status === "create")
            .map((r) => {
              const ref = wpRef(r.at, entityPrefix(i));
              const mains = b.entity.children.filter((w) => w.kind === "WORKPLACE").map((w) => ({ id: w.id, name: w.name }));
              return <SiteCard key={ref} name={`${r.name} · ${b.entity.name}`} value={answers[ref] ?? emptyAnswers()} onChange={(a) => onAnswer(ref, a)} mains={mains} />;
            }),
        )}
        {plan.errors.length > 0 && (
          <section className={s.errorCard} aria-labelledby="errors-head">
            <h2 id="errors-head" className={s.cardHead}><TriangleAlert size={16} aria-hidden /> {t("orgBulk.import.errorsHead", { count: plan.errors.length })}</h2>
            <ul className={s.refused}>
              {plan.errors.map((e) => <li key={e.line}>{t(`orgBulk.import.error.${e.kind}`, { line: e.line, name: e.name ?? "" })}</li>)}
            </ul>
            <p className={s.note}>{t("orgBulk.import.errorFix")}</p>
          </section>
        )}
      </aside>
    </div>
  );
}
