import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { PickOne } from "../../../reference/entity/ui/pick-one";
import { TextArea } from "../../../ui/field/text-area";
import { Receipt } from "../../../ui/receipt/receipt";
import { entitiesRef as entitiesQuery } from "../../../reference/entity/api";
import { BATCH_READS, commitBatches, RowsRefused, structureQuery, type Committed } from "../api";
import { emptyAnswers, entityOps, openQuestions, orgOps, ready, wpRef, type SiteAnswers } from "../domain/ops";
import { parseOutline } from "../domain/outline";
import { planCounts, planOutline, type PlanRoot } from "../domain/plan";
import { BulkHead } from "./bulk-head";
import { CommittedReceipt } from "./committed";
import { PlanList } from "./plan-list";
import { SiteCard } from "./site-card";
import s from "./bulk.module.css";

const route = getRouteApi("/app/org/paste");

/** S7 paste a list: a full page under one legal entity (`?entity=`) or one workplace (`?workplace=`); without one it asks where. */
export function PastePage() {
  const { entity, workplace } = route.useSearch();
  const tree = useQuery(structureQuery);
  return (
    <QueryState q={tree}>
      {(d) => {
        const ents = d.entities.filter((e) => e.kind === "LEGAL_ENTITY");
        const at = findRoot(ents, entity, workplace);
        return at ? <PasteEditor key={at.root.node.id} root={at.root} entity={at.owner} operating={d.phase === "OPERATING"} /> : <PickRoot entities={ents} />;
      }}
    </QueryState>
  );
}

/** The legal entity or workplace the search names, and the legal entity it belongs to. */
function findRoot(ents: Node[], entity?: string, workplace?: string): { root: PlanRoot; owner: Node } | undefined {
  for (const e of ents) {
    if (e.id === entity) return { root: { kind: "entity", node: e }, owner: e };
    const w = workplace ? e.children.find((c) => c.id === workplace) : undefined;
    if (w) return { root: { kind: "workplace", node: w }, owner: e };
  }
  return undefined;
}

function PickRoot({ entities }: { entities: Node[] }) {
  const navigate = route.useNavigate();
  const pick = (v: string) => void navigate({ search: v.startsWith("e:") ? { entity: v.slice(2) } : { workplace: v.slice(2) } });
  const options = entities.flatMap((e) => [{ value: `e:${e.id}`, label: e.name }, ...e.children.filter((w) => w.kind === "WORKPLACE").map((w) => ({ value: `w:${w.id}`, label: t("orgBulk.import.sitePath", { entity: e.name, name: w.name }) }))]);
  return (
    <div className={s.frame}>
      <BulkHead title={t("orgBulk.paste.title")} />
      <div className={s.body}>
        {options.length === 0 ? (
          <p className={s.note}>{t("orgBulk.paste.noEntity")}</p>
        ) : (
          // Every place is offered (a group with many workplaces still reaches its later legal entities): past 15, a search.
          <PickOne label={t("orgBulk.paste.pickRoot")} required  options={options} value={null} onChange={pick} group={t("orgBulk.paste.pickRoot")} empty={t("orgBulk.paste.pickRootNone")} />
        )}
      </div>
    </div>
  );
}

function PasteEditor({ root, entity, operating }: { root: PlanRoot; entity: Node; operating: boolean }) {
  const [text, setText] = useState("");
  const [names, setNames] = useState<Record<number, string>>({});
  const [answers, setAnswers] = useState<Record<string, SiteAnswers>>({});
  const [done, setDone] = useState<{ c: Committed; w: number; d: number } | null>(null);
  const memo = useRef<{ entity?: Committed }>({});
  const entities = useQuery(entitiesQuery);
  const corp = entities.data?.items.find((e) => e.id === entity.id)?.biz_kind === "CORPORATION";
  const { rows: outline, shape } = useMemo(() => parseOutline(text), [text]);
  const plan = useMemo(() => planOutline(root, outline, names), [root, outline, names]);
  const counts = planCounts(plan);
  const newSites = plan.filter((r) => r.level === "workplace" && r.status === "create");
  const open = newSites.reduce((n, r) => n + openQuestions(answers[wpRef(r.at)] ?? emptyAnswers()), 0);
  const mains = entity.children.filter((w) => w.kind === "WORKPLACE").map((w) => ({ id: w.id, name: w.name }));
  const commit = useCommand({
    run: (_: undefined, key: string) => commitBatches(key, entityOps(root, plan, answers, corp), (ids) => orgOps(root, plan, ids), memo.current),
    invalidates: BATCH_READS,
    announce: () => t("orgBulk.done", { workplaces: counts.workplaces, depts: counts.depts }),
    onSuccess: (c) => setDone({ c, w: counts.workplaces, d: counts.depts }),
  });
  const restart = () => {
    setText(""); setNames({}); setAnswers({}); setDone(null); memo.current = {};
  };
  // The legal entity kind decides the withholding sent for a new workplace, so nothing commits before it is read.
  const can = !operating && entities.isSuccess && ready(plan, answers) && !commit.isPending;
  const foot =
    operating ? t("orgBulk.foot.operating")
    : plan.length === 0 ? t("orgBulk.foot.empty")
    : counts.fix || open ? t("orgBulk.foot.blocked", { fix: counts.fix, open })
    : counts.workplaces + counts.depts === 0 ? t("orgBulk.foot.nothing")
    : t("orgBulk.foot.ready", { workplaces: counts.workplaces, depts: counts.depts });
  const under = root.kind === "entity" ? t("orgBulk.paste.under.entity", { entity: root.node.name }) : t("orgBulk.paste.under.workplace", { workplace: root.node.name });

  if (done)
    return (
      <div className={s.frame}>
        <BulkHead title={t("orgBulk.paste.title")} under={under} />
        <div className={s.body}>
          <CommittedReceipt committed={done.c} message={t("orgBulk.done", { workplaces: done.w, depts: done.d })} again={restart} />
        </div>
      </div>
    );
  return (
    <div className={s.frame}>
      <BulkHead title={t("orgBulk.paste.title")} under={under} />
      <div className={`${s.body} ${s.cols3}`}>
        <section className={s.col}>
          <h2 className={s.colHead}>
            <label htmlFor="paste-text">{t("orgBulk.paste.input")}</label>
            <span className={s.legend}>{t("orgBulk.paste.lines", { count: outline.length })}</span>
          </h2>
          <TextArea id="paste-text" className={s.paste} value={text} placeholder={t("orgBulk.paste.placeholder")} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          {outline.length > 0 && <p className={s.note} role="status">{t("orgBulk.paste.shape", { by: shape.by, depth: shape.depth, kind: shape.kindColumn ? "yes" : "no" })}</p>}
        </section>
        <section className={s.col} aria-labelledby="plan-title">
          <h2 id="plan-title" className={s.colHead}>
            {t("orgBulk.plan.title")}
            <span className={s.legend}>
              <span>{t("orgBulk.plan.count.create", { count: counts.workplaces + counts.depts })}</span>
              <span>{t("orgBulk.plan.count.link", { count: counts.links })}</span>
              {counts.fix > 0 && <span>{t("orgBulk.plan.count.fix", { count: counts.fix })}</span>}
            </span>
          </h2>
          {plan.length ? (
            <PlanList rows={plan} names={names} onRename={(at, n) => setNames((x) => ({ ...x, [at]: n }))} rootName={root.node.name} levelOffset={root.kind === "workplace" ? 1 : 0} />
          ) : (
            <p className={s.note}>{t("orgBulk.plan.empty")}</p>
          )}
        </section>
        <aside className={s.rail}>
          {newSites.map((r) => (
            <SiteCard key={r.at} name={r.name} value={answers[wpRef(r.at)] ?? emptyAnswers()} onChange={(v) => setAnswers((x) => ({ ...x, [wpRef(r.at)]: v }))} mains={mains} />
          ))}
          <section className={`card ${s.card}`}>
            <h2 className={s.cardHead}>{t("orgBulk.summary.title")}</h2>
            <p className={s.note}>{t("orgBulk.summary.what", { workplaces: counts.workplaces, depts: counts.depts, links: counts.links })}</p>
            <p className={s.note}>{operating ? t("orgBulk.summary.operating") : t("orgBulk.summary.setup", { total: counts.workplaces + counts.depts })}</p>
          </section>
        </aside>
      </div>
      <footer className={s.foot}>
        <p className={s.footText} data-tone={can || plan.length === 0 ? undefined : "warn"} id="paste-foot">{foot}</p>
        {commit.isPending && <Receipt state="sending" message={t("orgBulk.sending")} />}
        {commit.error instanceof RowsRefused ? (
          <div role="alert">
            <p className={s.danger}>{t("orgBulk.refused", { count: commit.error.items.length })}</p>
            <ul className={s.refused}>
              {commit.error.items.map((i) => <li key={i.index}>{t("orgBulk.refusedRow", { name: plan.find((r) => wpRef(r.at) === i.ref)?.name ?? i.ref ?? "", message: i.error?.message ?? "" })}</li>)}
            </ul>
          </div>
        ) : commit.error != null && <CommandError error={commit.error} />}
        <Link to="/org" search={{}} className="btn">{t("orgBulk.cancel")}</Link>
        <Button variant="primary" aria-disabled={!can || undefined} aria-describedby="paste-foot" onClick={() => can && commit.mutate(undefined)}>
          {t("orgBulk.submit", { workplaces: counts.workplaces, depts: counts.depts })}
        </Button>
      </footer>
    </div>
  );
}
