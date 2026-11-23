import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCan } from "../../../reference/authz/ui/use-can";
import { buttonClass } from "../../../ui/button/button-class";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { Table, type Column } from "../../../ui/table";
import { noticesQuery } from "../api";

type NoticeSummary = components["schemas"]["AppointmentNoticeSummary"];

/** The notices made so far, newest first (spec E5-notice): each opens as its document. */
export function NoticeListPage({ embedded = false }: { embedded?: boolean } = {}) {
  const nav = useNavigate();
  const can = useCan();
  const q = useQuery(noticesQuery);
  const manage = can("employee_directory_manage", "tenant");
  const columns: Column<NoticeSummary>[] = [
    { header: t("notice.list.col.no"), cell: (n) => <span className="num">{n.notice_no}</span>, fit: true, card: "title" },
    { header: t("notice.list.col.title"), cell: (n) => n.title, card: "fact" },
    { header: t("notice.list.col.date"), cell: (n) => <bdi className="num">{fmtDate(n.notice_date)}</bdi>, fit: true, card: "omit" },
    { header: t("notice.list.col.lines"), cell: (n) => <bdi className="num">{n.line_count}</bdi>, fit: true, card: "status" },
  ];
  const empty = <EmptyState title={t("notice.list.empty")} reason={t("notice.missing.what")} />;
  const table = (rows: NoticeSummary[], compact: boolean) => (
    <Table
      label={t("notice.list")}
      rows={rows}
      rowId={(n) => n.id}
      density={compact ? "compact" : undefined}
      mobileLayout={compact ? "compact" : undefined}
      onSelect={(id) => void nav({ to: "/people/notices/$noticeId", params: { noticeId: id } })}
      columns={columns}
    />
  );

  const renderBaseline = () => (
    <div className="page">
      <PageHead crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("notice.crumb")} />} title={t("notice.title")} tools={manage && <Link to="/people/notices/new" className={buttonClass("primary")}>{t("notice.new.title")}</Link>} />
      <Card label={t("notice.list")} flush>
        <QueryState q={q} layout="list" empty={(d) => (d.items.length ? null : empty)}>
          {(d) => table(d.items, false)}
        </QueryState>
      </Card>
    </div>
  );

  return (
    <ExperienceSwitch baseline={renderBaseline}>
      {() =>
        embedded ? (
          <section aria-labelledby="appointments-notices-title">
            <PaneHead title={t("notice.title")} titleId="appointments-notices-title" />
            <QueryState q={q} layout="list" empty={(d) => (d.items.length ? null : empty)}>
              {(d) => table(d.items, true)}
            </QueryState>
          </section>
        ) : (
          <ListRecord
            q={q}
            head={{
              title: t("notice.title"),
              primary: manage ? { id: "new-notice", label: t("notice.new.title"), onAction: () => void nav({ to: "/people/notices/new" }) } : undefined,
            }}
            list={q.data ? (q.data.items.length === 0 ? empty : table(q.data.items, true)) : null}
            statusSegments={q.data ? [{ id: "scope", content: t("notice.title") }, { id: "count", content: String(q.data.items.length) }] : null}
          />
        )
      }
    </ExperienceSwitch>
  );
}
