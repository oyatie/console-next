import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { queryView } from "../../../lib/react/query-view";
import { todayKst } from "../../../lib/pure/today";
import { buttonClass } from "../../../ui/button/button-class";
import { Button, Check } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { DateField } from "../../../ui/date/date-field";
import { datePresets } from "../../../ui/date/date-text";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Kbd } from "../../../ui/kbd/kbd";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { Table } from "../../../ui/table";
import { failureOf, issueNotice, noticeCandidatesPages } from "../api";
import { after, before } from "../domain/notice";
import s from "./notice.module.css";

/** The notice that already holds an act (409 appointment_notice_event_taken names it per act). */
const takenNo = (e: unknown) => {
  const f = failureOf(e);
  return (f.kind === "refused" && (f.refusals[0] as { notice_no?: string } | undefined)?.notice_no) || "?";
};

const route = getRouteApi("/app/people/notices/new");
const TITLE_MAX = 200;
const NOTE_MAX = 1000;

/**
 * Making an appointment notice (spec E5-notice, BE-EMP-UI §4): selected events or one bulk receipt, a title, the
 * notice date and a note; the commit takes the company's next notice number and opens the document. The number is the server's, given at
 * issue and never reused; a refused issue takes none.
 */
export function NoticeNewPage() {
  const { batch, events, count } = route.useSearch();
  const nav = route.useNavigate();
  const today = todayKst();
  const [title, setTitle] = useState(t("notice.doc.head").replace(/\s/g, ""));
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const given = events ? events.split(",").filter(Boolean) : [];
  const choosing = !batch && given.length === 0;
  const candidates = useInfiniteQuery({ ...noticeCandidatesPages, enabled: choosing });
  const view = queryView(candidates);
  const lines = (view === "denied" || view === "not-found" ? [] : candidates.data?.pages.flatMap((p) => p.items) ?? []).map((c, i) => ({ ...c, line_no: i + 1 })).sort((a, b) => a.event.effective_date.localeCompare(b.event.effective_date));
  const picked = lines.filter((c) => selected.includes(c.event.id));
  const ids = choosing ? picked.map((c) => c.event.id) : given;
  const dates = [...new Set(lines.map((c) => c.event.effective_date))].sort();
  const issue = useCommand({
    run: (_: void, key: string) => issueNotice({ title: title.trim(), notice_date: date, batch_id: batch, event_ids: ids.length ? ids : undefined, note: note.trim() || null }, key),
    invalidates: ["/api/v1/appointment-notices"],
    onSuccess: (n) => void nav({ to: "/people/notices/$noticeId", params: { noticeId: n.id } }),
  });
  const gaps = { title: !title.trim(), date: !date, events: !batch && ids.length === 0 };
  const submit = () => (setTried(true), !gaps.title && !gaps.date && !gaps.events && !issue.isPending && issue.mutate(undefined));
  return (
    <div className="page">
      <PageHead crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>, <Link key="notices" to="/people/notices">{t("notice.crumb")}</Link>]} />} title={t("notice.title")} />
      {choosing && <Card title={t("notice.pick.title")}>
        <QueryState q={candidates} layout="list">
          {() => lines.length === 0
          ? <EmptyState title={t("notice.pick.empty")} reason={t("notice.missing.what")} actions={<Link to="/people" search={{}} className={buttonClass()}>{t("people.title")}</Link>} />
          : <div className={s.form}>
            {dates.map((effectiveDate) => <section key={effectiveDate} aria-label={fmtDate(effectiveDate)}>
              <h3>{fmtDate(effectiveDate)}</h3>
              {lines.filter((c) => c.event.effective_date === effectiveDate).map((c) => <Check key={c.event.id} checked={selected.includes(c.event.id)} onChange={(checked) => setSelected((current) => checked ? [...current, c.event.id] : current.filter((id) => id !== c.event.id))}>
                {c.name} · {label(LIFECYCLE_EVENT, c.event.event_type)} · {after(c)}
              </Check>)}
            </section>)}
            {candidates.hasNextPage && <Button aria-disabled={candidates.isFetchingNextPage || undefined} onClick={() => { if (!candidates.isFetchingNextPage) void candidates.fetchNextPage(); }}>{t("notice.pick.more")}</Button>}
          </div>}
        </QueryState>
      </Card>}
      {(!choosing || lines.length > 0) && <Card titleId="notice-new" title={<><FileText size={16} aria-hidden /> {batch ? t("notice.new.of", { count: count ?? 0 }) : t("notice.new.ofEvents", { count: ids.length })}</>}>
        <div className={s.form}>
        <Field label={t("notice.field.title")} required error={tried && gaps.title ? t("notice.missing.title") : undefined}>
          {(p) => <TextInput {...p} maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <DateField label={t("notice.field.date")} required today={today} presets={datePresets(today, ["today"])} value={date} onChange={setDate} echo={date ? t("notice.field.dateEcho") : undefined} error={tried && gaps.date ? t("notice.missing.date") : undefined} showErrors={tried} />
        <Field label={t("notice.field.note")} required={false}>
          {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <div className={s.actions}>{!gaps.events && <>
          <Button variant="primary" aria-disabled={issue.isPending || undefined} onClick={submit}>{t("notice.new.title")}<Kbd keys="⌘↵" /></Button>
        </>}</div>
        </div>
      </Card>}
      <CommandError error={issue.error} own={(code) => (isMessageId(`notice.error.${code}`) ? t(`notice.error.${code}` as never, { no: takenNo(issue.error) }) : undefined)} />
      {choosing && lines.length > 0 && <Card title={t("notice.preview.title")} label={t("notice.preview.title")}>
        <Table label={t("notice.preview.title")} rows={picked} rowId={(c) => c.event.id} columns={[
          { header: t("notice.doc.col.name"), cell: (c) => c.name },
          { header: t("notice.doc.col.number"), cell: (c) => c.employee_number ?? "—" },
          { header: t("notice.doc.col.before"), cell: before },
          { header: t("notice.doc.col.after"), cell: after },
        ]} />
      </Card>}

    </div>
  );
}
