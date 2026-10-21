import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { BIZ_KIND, label, labeled, VERIFICATION } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { checklistRef, entitiesAt } from "../../../reference/entity/api";
import { todayKst } from "../../../lib/pure/today";
import { headcount, primaryRegistration } from "../domain/view";
import { QuickAdd } from "./entity-quick-add";
import { UnattachedWorkplaces } from "./unattached-workplaces";
import { AsOfBand } from "./asof-band";

import { EntityName } from "../../../reference/entity/ui/entity-name";
import { NameProblems } from "./name-problems";

const route = getRouteApi("/app/org/entities");

/** The tenant's legal entities (design §0 E1): each with its kind, main registration, workplaces and people. */
export function EntityList() {
  const { add, as_of, known_at } = route.useSearch();
  const list = useQuery(entitiesAt({ as_of, known_at }));
  const phase = useQuery(checklistRef).data?.phase;
  const nav = useNavigate();
  const navigate = route.useNavigate();
  const today = todayKst();
  const readOnly = Boolean(known_at) || Boolean(as_of && as_of !== today) || Boolean(list.data?.items.some((e) => e.read_only));
  const changeDate = (date: string, knownAt?: string) => void navigate({ search: (s) => ({ ...s, add: undefined, as_of: date === today ? undefined : date, known_at: knownAt }) });
  return (
    <div className="page">
      <section className="card">
        <div className="toolbar">
          <h1 id="entities-title" className="toolbar__title" tabIndex={-1}>{t("entity.list.title")}</h1>
          {phase === "SETUP" && <Chip tone="info">{t("entity.phase.setup")}</Chip>}
          {!readOnly && <Link to="/org/entities" search={(s) => ({ ...s, add: true })} className="btn btn--primary">
            <Plus size={16} aria-hidden /> {t("entityQuick.title")}
          </Link>}
        </div>
        <AsOfBand asOf={as_of} knownAt={known_at} onChange={changeDate} />
        <QueryState
          q={list}
          empty={(d) =>
            d.items.length ? null : (
              <EmptyState
                title={t("entity.empty.title")}
                reason={t("entity.empty.reason")}
                actions={!readOnly && <Link to="/org/entities/new" className="btn btn--primary">{t("entity.empty.action")}</Link>}
              />
            )
          }
        >
          {(d) => (
            <Table
              label={t("entity.list.table")}
              rows={d.items}
              rowId={(e) => e.id}
              onSelect={(id) => void nav({ to: "/org/entities/$id", params: { id }, search: { as_of, known_at } })}
              columns={[
                { header: t("entity.col.name"), cell: (e) => <><EntityName entity={e} /><NameProblems e={e} /></> },
                { header: t("entity.col.kind"), cell: (e) => (e.biz_kind ? label(BIZ_KIND, e.biz_kind) : t("entity.kindUnset")), fit: true },
                { header: t("entity.col.brn"), cell: (e) => <code>{primaryRegistration(e)?.brn?.display ?? "—"}</code>, fit: true },
                { header: t("entity.col.workplaces"), cell: (e) => <data className="num" value={e.workplaces.length}>{t("entity.count.workplaces", { count: e.workplaces.length })}</data>, fit: true },
                { header: t("entity.col.people"), cell: (e) => <data className="num" value={headcount(e)}>{t("entity.count.people", { count: headcount(e) })}</data>, fit: true, wide: true },
                {
                  header: t("entity.col.status"),
                  fit: true,
                  cell: (e) => {
                    const r = primaryRegistration(e);
                    const v = r ? labeled(VERIFICATION, r.verification_tier) : null;
                    const attention = e.registrations.filter((x) => x.needs_confirmation).length + e.workplaces.filter((w) => w.needs_confirmation).length;
                    return (
                      <span className="row">
                        {v ? <Chip tone={v.tone}>{v.label}</Chip> : <Chip tone="warn">{t("workplace.noRegistration")}</Chip>}
                        {e.needs_confirmation && <Chip tone="warn">{t("entity.needsConfirmation")}</Chip>}
                        {attention > 0 && <Chip tone="warn">{t("entity.attention", { count: attention })}</Chip>}
                      </span>
                    );
                  },
                },
              ]}
            />
          )}
        </QueryState>
      </section>
      {/* Below the list: arriving with the read, it never pushes the table down (layout shift budget). */}
      {list.data && <UnattachedWorkplaces entities={list.data.items} />}
      {!readOnly && <QuickAdd open={add === true} onClose={() => void navigate({ search: (s) => ({ ...s, add: undefined }) })} />}
    </div>
  );
}
