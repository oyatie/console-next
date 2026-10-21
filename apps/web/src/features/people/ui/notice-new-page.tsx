import { useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { isMessageId, t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { DateChips } from "../../../ui/date/date-chips";
import { datePresets } from "../../../ui/date/date-text";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Kbd } from "../../../ui/kbd/kbd";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { failureOf, issueNotice } from "../api";
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
 * Making an appointment notice (spec E5-notice, BE-EMP-UI §4): for one bulk batch (or named events), a title, the
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
  const ids = events ? events.split(",").filter(Boolean) : [];
  const issue = useCommand({
    run: (_: void, key: string) => issueNotice({ title: title.trim(), notice_date: date, batch_id: batch, event_ids: ids.length ? ids : undefined, note: note.trim() || null }, key),
    invalidates: ["/api/v1/appointment-notices"],
    onSuccess: (n) => void nav({ to: "/people/notices/$noticeId", params: { noticeId: n.id } }),
  });
  if (!batch && ids.length === 0) return <div className="page"><EmptyState title={t("notice.title")} reason={t("notice.missing.what")} actions={<Link className={buttonClass("primary")} to="/people" search={{}}>{t("people.title")}</Link>} /></div>;
  const gaps = { title: !title.trim(), date: !date };
  const submit = () => (setTried(true), !gaps.title && !gaps.date && !issue.isPending && issue.mutate(undefined));
  return (
    <div className="page">
      <PageHead crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>, <Link key="notices" to="/people/notices">{t("notice.crumb")}</Link>]} />} title={t("notice.new.title")} />
      <Card titleId="notice-new" title={<><FileText size={16} aria-hidden /> {batch ? t("notice.new.of", { count: count ?? 0 }) : t("notice.new.ofEvents", { count: ids.length })}</>}>
        <div className={s.form}>
        <Field label={t("notice.field.title")} required error={tried && gaps.title ? t("notice.missing.title") : undefined}>
          {(p) => <TextInput {...p} maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <DateChips label={t("notice.field.date")} required presets={datePresets(today, ["today"])} value={date} onChange={setDate} echo={date ? t("notice.field.dateEcho") : undefined} error={tried && gaps.date ? t("notice.missing.date") : undefined} showErrors={tried} />
        <Field label={t("notice.field.note")} required={false}>
          {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <CommandError error={issue.error} own={(code) => (isMessageId(`notice.error.${code}`) ? t(`notice.error.${code}` as never, { no: takenNo(issue.error) }) : undefined)} />
        <div className={s.actions}>
          <Button variant="primary" aria-disabled={issue.isPending || undefined} onClick={submit}>{t("notice.commit")}<Kbd keys="⌘↵" /></Button>
        </div>
        </div>
      </Card>
    </div>
  );
}
