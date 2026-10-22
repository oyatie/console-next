import { EnumValue } from "../../../ui/enum-value";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Copy, Printer } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { LEAVE_TYPE, LIFECYCLE_EVENT, label, labeled } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { entitiesRef } from "../../../reference/entity/api";
import { Button } from "../../../ui/button/button";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { Table } from "../../../ui/table";
import { noticeQuery, type Notice } from "../api";
import { after, before, sections } from "../domain/notice";
import s from "./notice.module.css";
import { entityName } from "../../../reference/entity/domain/names";

const route = getRouteApi("/app/people/notices/$noticeId");

/**
 * One appointment notice as a document (spec E5-notice): its heading, number and date, a section per act with each
 * person's unit and position before and the appointment, and the company's line. Printed (or saved as PDF) by the
 * browser; copy-as-text hands the same lines out. Nothing on it but what an appointment notice carries (no birth date, contact or reason).
 */
export function NoticePage() {
  const { noticeId } = route.useParams();
  const q = useQuery(noticeQuery(noticeId));
  return (
    <div className="page">
      <div className={s.noPrint}>
        <PageHead crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>, <Link key="notices" to="/people/notices">{t("notice.crumb")}</Link>]} />} title={t("notice.title")} />
      </div>
      <QueryState q={q}>{(n) => <Doc n={n} />}</QueryState>
    </div>
  );
}

function Doc({ n }: { n: Notice }) {
  const entity = entityName(useQuery(entitiesRef).data?.items[0]);
  const [copied, setCopied] = useState(false);
  const parts = sections(n.lines);
  const text = [
    t("notice.doc.head"),
    t("notice.doc.no", { no: n.notice_no, date: fmtDate(n.notice_date) }),
    ...parts.flatMap((p, i) => [t("notice.doc.section", { n: i + 1, kind: label(LIFECYCLE_EVENT, p.kind), count: p.lines.length }), ...p.lines.map((l) => [l.name, l.employee_number ?? "—", before(l), [after(l), l.event.leave_type && labeled(LEAVE_TYPE, l.event.leave_type).code && label(LEAVE_TYPE, l.event.leave_type)].filter(Boolean).join(" · ")].join("\t"))]),
    t("notice.doc.foot", { date: fmtDate(n.notice_date), entity }),
  ].join("\n");
  return (
    <>
      <div className={`${s.bar} ${s.noPrint}`}>
        <span className={s.muted}>{t("notice.doc.issued", { name: n.issued_by_name ?? "—", at: fmtDateTime(n.issued_at) })}</span>
        <span className={s.grow} />
        <Button onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}><Copy size={16} aria-hidden />{t("notice.copy")}</Button>
        <Button variant="primary" onClick={() => window.print()}><Printer size={16} aria-hidden />{t("notice.print")}</Button>
        {copied && <span role="status" className={s.muted}>{t("notice.copied")}</span>}
      </div>
      <article className={s.doc} aria-label={t("notice.doc.no", { no: n.notice_no, date: fmtDate(n.notice_date) })}>
        <h2 className={s.docHead}>{t("notice.doc.head")}</h2>
        <p className={s.docNo}>{t("notice.doc.no", { no: n.notice_no, date: fmtDate(n.notice_date) })}</p>
        {n.title.replace(/\s/g, "") !== t("notice.doc.head").replace(/\s/g, "") && <p className={s.docNo}>{n.title}</p>}
        {parts.map((p, i) => (
          <section key={p.kind} className={s.docSection}>
            <h3>{t("notice.doc.section", { n: i + 1, kind: label(LIFECYCLE_EVENT, p.kind), count: p.lines.length })}</h3>
            <div className={s.docTable}>
              <Table
                label={t("notice.doc.section", { n: i + 1, kind: label(LIFECYCLE_EVENT, p.kind), count: p.lines.length })}
                rows={p.lines}
                rowId={(l) => String(l.line_no)}
                columns={[
                  { header: t("notice.doc.col.name"), cell: (l) => l.name },
                  { header: t("notice.doc.col.number"), cell: (l) => <span className="num">{l.employee_number ?? "—"}</span>, fit: true },
                  { header: t("notice.doc.col.before"), cell: before },
                  { header: t("notice.doc.col.after"), cell: (l) => <>{after(l)}{l.event.leave_type && labeled(LEAVE_TYPE, l.event.leave_type).code && <> · <EnumValue e={LEAVE_TYPE} value={l.event.leave_type} /></>}</> },
                ]}
              />
            </div>
          </section>
        ))}
        {n.note && <p className={s.docNote}>{n.note}</p>}
        <p className={s.docFoot}>{t("notice.doc.foot", { date: fmtDate(n.notice_date), entity })}</p>
      </article>
    </>
  );
}
