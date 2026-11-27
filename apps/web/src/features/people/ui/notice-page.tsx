import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Copy, Printer } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { entitiesRef } from "../../../reference/entity/api";
import { Button } from "../../../ui/button/button";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { FormSection } from "../../../ui/patterns/form-section";
import { RecordPattern } from "../../../ui/patterns/record";
import { Table } from "../../../ui/table";
import { noticeQuery, type Notice } from "../api";
import { after, before, sections } from "../domain/notice";
import s from "./notice.module.css";
import { entityName } from "../../../reference/entity/domain/names";

const route = getRouteApi("/app/people/notices/$noticeId");
// The notice as printed and copied keeps the locale date form whatever the screen style draws.
const day = (v: unknown) => fmtDate(v, { style: "locale" });

/**
 * One appointment notice as a document (spec E5-notice): its heading, number and date, a section per act with each
 * person's unit and position before and the appointment, and the company's line. Printed (or saved as PDF) by the
 * browser; copy-as-text hands the same lines out. Nothing on it but what an appointment notice carries (no birth date, contact or reason).
 */
export function NoticePage() {
  const { noticeId } = route.useParams();
  const q = useQuery(noticeQuery(noticeId));
  const entitiesQ = useQuery(entitiesRef);
  const [copyMessage, setCopyMessage] = useState<"notice.copied" | "notice.copyFailed">();
  const view = queryView(q);
  const n = view === "denied" || view === "not-found" ? undefined : q.data;
  const entity = entityName(entitiesQ.data?.items[0]);
  const parts = n ? sections(n.lines) : [];
  const text = n
    ? [
        t("notice.doc.head"),
        t("notice.doc.no", { no: n.notice_no, date: day(n.notice_date) }),
        ...parts.flatMap((p, i) => [t("notice.doc.section", { n: i + 1, kind: label(LIFECYCLE_EVENT, p.kind), count: p.lines.length }), ...p.lines.map((l) => [l.name, l.employee_number ?? "—", before(l), after(l)].join("\t"))]),
        t("notice.doc.foot", { date: day(n.notice_date), entity }),
      ].join("\n")
    : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage("notice.copied");
    } catch {
      setCopyMessage("notice.copyFailed");
    }
  };
  const feedback = copyMessage && <span className={s.muted} role="status">{t(copyMessage)}</span>;

  const renderBaseline = () => (
    <div className="page">
      <div className={s.noPrint}>
        <PageHead crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>, <Link key="notices" to="/people/notices">{t("notice.crumb")}</Link>]} />} title={t("notice.title")} />
      </div>
      <QueryState q={q} back={{ to: "/people/notices", label: t("notice.crumb") }} layout="record">
        {(loaded) => <Doc n={loaded} entity={entity} feedback={feedback} onCopy={copy} />}
      </QueryState>
    </div>
  );

  return (
    <RecordPattern
      q={q}
      baseline={renderBaseline}
      back={{ to: "/people/notices", label: t("notice.crumb") }}
      head={{
        title: t("notice.title"),
        crumbs: <Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>, <Link key="notices" to="/people/notices">{t("notice.crumb")}</Link>]} />,
        meta: n ? <bdi className="num">{t("notice.doc.issued", { name: n.issued_by_name ?? "—", at: fmtDateTime(n.issued_at) })}</bdi> : undefined,
        actions: n ? (
          <>
            <Button size="sm" onClick={copy}><Copy size={14} aria-hidden />{t("notice.copy")}</Button>
            <Button size="sm" variant="primary" onClick={() => window.print()}><Printer size={14} aria-hidden />{t("notice.print")}</Button>
          </>
        ) : undefined,
      }}
      notes={feedback}
      sections={
        n ? (
          <FormSection>
            <div data-print-doc="">
              <NoticeArticle n={n} parts={parts} entity={entity} />
            </div>
          </FormSection>
        ) : null
      }
      statusSegments={n ? [{ id: "no", tone: "strong", content: n.notice_no }, { id: "date", content: fmtDate(n.notice_date) }, { id: "lines", content: String(n.line_count) }] : null}
    />
  );
}

function NoticeArticle({ n, parts, entity }: { n: Notice; parts: ReturnType<typeof sections>; entity: string }) {
  return (
    <article className={s.doc} aria-label={t("notice.doc.no", { no: n.notice_no, date: day(n.notice_date) })}>
      <h2 className={s.docHead}>{t("notice.doc.head")}</h2>
      <p className={s.docNo}>{t("notice.doc.no", { no: n.notice_no, date: day(n.notice_date) })}</p>
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
                { header: t("notice.doc.col.after"), cell: after },
              ]}
            />
          </div>
        </section>
      ))}
      {n.note && <p className={s.docNote}>{n.note}</p>}
      <p className={s.docFoot}>{t("notice.doc.foot", { date: day(n.notice_date), entity })}</p>
    </article>
  );
}

function Doc({ n, entity, feedback, onCopy }: { n: Notice; entity: string; feedback: ReactNode; onCopy: () => void }) {
  const parts = sections(n.lines);
  return (
    <>
      <div className={`${s.bar} ${s.noPrint}`}>
        <span className={s.muted}>{t("notice.doc.issued", { name: n.issued_by_name ?? "—", at: fmtDateTime(n.issued_at) })}</span>
        <span className={s.grow} />
        <Button onClick={onCopy}><Copy size={16} aria-hidden />{t("notice.copy")}</Button>
        <Button variant="primary" onClick={() => window.print()}><Printer size={16} aria-hidden />{t("notice.print")}</Button>
        {feedback}
      </div>
      <NoticeArticle n={n} parts={parts} entity={entity} />
    </>
  );
}
