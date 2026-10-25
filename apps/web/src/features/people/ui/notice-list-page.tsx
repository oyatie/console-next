import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { Table } from "../../../ui/table";
import { noticesQuery } from "../api";

/** The notices made so far, newest first (spec E5-notice): each opens as its document. */
export function NoticeListPage() {
  const nav = useNavigate();
  const q = useQuery(noticesQuery);
  return (
    <div className="page">
      <PageHead crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("notice.crumb")} />} title={t("notice.list")} />
      <Card label={t("notice.list")} flush>
        <QueryState q={q} layout="list" empty={(d) => (d.items.length ? null : <EmptyState title={t("notice.list.empty")} reason={t("notice.missing.what")} />)}>
          {(d) => (
            <Table
              label={t("notice.list")}
              rows={d.items}
              rowId={(n) => n.id}
              onSelect={(id) => void nav({ to: "/people/notices/$noticeId", params: { noticeId: id } })}
              columns={[
                { header: t("notice.list.col.no"), cell: (n) => <span className="num">{n.notice_no}</span>, fit: true },
                { header: t("notice.list.col.title"), cell: (n) => n.title },
                { header: t("notice.list.col.date"), cell: (n) => <span className="num">{fmtDate(n.notice_date)}</span>, fit: true },
                { header: t("notice.list.col.lines"), cell: (n) => <span className="num">{n.line_count}</span>, fit: true },
              ]}
            />
          )}
        </QueryState>
      </Card>
    </div>
  );
}
