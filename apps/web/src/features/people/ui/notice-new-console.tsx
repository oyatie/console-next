// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { CommandError } from "../../../lib/react/command-error";
import type { ReadState } from "../../../lib/react/query-view";
import { Button, Check } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { DateField } from "../../../ui/date/date-field";
import { datePresets } from "../../../ui/date/date-text";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Kbd } from "../../../ui/kbd/kbd";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { FormSection } from "../../../ui/patterns/form-section";
import { WizardPattern } from "../../../ui/patterns/wizard";
import { Table } from "../../../ui/table";
import type { NoticeCandidate } from "../api";
import { after, before } from "../domain/notice";
import s from "./notice.module.css";

const READY_READ: ReadState = { isPending: false, error: null, data: { ready: true }, refetch: () => {} };
const TITLE_MAX = 200;
const NOTE_MAX = 1000;

type CandidateLine = NoticeCandidate & { line_no: number };

export function NoticeNewConsole({
  choosing,
  candidatesQ,
  hasNextPage,
  isFetchingNextPage,
  onFetchNextPage,
  lines,
  picked,
  dates,
  selected,
  onToggleSelected,
  batch,
  count,
  idsLength,
  today,
  title,
  onTitle,
  date,
  onDate,
  memo,
  onMemo,
  tried,
  gaps,
  pending,
  error,
  takenNo,
  onSubmit,
}: {
  choosing: boolean;
  candidatesQ: ReadState;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onFetchNextPage: () => void;
  lines: readonly CandidateLine[];
  picked: readonly CandidateLine[];
  dates: readonly string[];
  selected: readonly string[];
  onToggleSelected: (id: string, checked: boolean) => void;
  batch?: string;
  count?: number;
  idsLength: number;
  today: string;
  title: string;
  onTitle: (value: string) => void;
  date: string;
  onDate: (value: string) => void;
  memo: string;
  onMemo: (value: string) => void;
  tried: boolean;
  gaps: { title: boolean; date: boolean; events: boolean };
  pending: boolean;
  error: unknown;
  takenNo: string;
  onSubmit: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || !(e.metaKey || e.ctrlKey) || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      onSubmit();
    };
    const targets = [bodyRef.current, asideRef.current].filter((n): n is HTMLDivElement => Boolean(n));
    for (const node of targets) node.addEventListener("keydown", onKey);
    return () => { for (const node of targets) node.removeEventListener("keydown", onKey); };
  }, [onSubmit]);

  const showForm = !choosing || lines.length > 0;
  const emptyCandidates = choosing && lines.length === 0;

  return (
    <WizardPattern
      q={choosing ? candidatesQ : READY_READ}
      back={{ to: "/people/notices", label: t("notice.crumb") }}
      head={{
        title: t("notice.title"),
        crumbs: (
          <Crumbs
            items={[
              <Link key="people" to="/people" search={{}}>{t("people.title")}</Link>,
              <Link key="notices" to="/people/notices">{t("notice.crumb")}</Link>,
            ]}
          />
        ),
      }}
      body={
        <div ref={bodyRef} className={s.form}>
          {emptyCandidates && (
            <EmptyState
              title={t("notice.pick.empty")}
              reason={t("notice.missing.what")}
              actions={<Link to="/people" search={{}} className={buttonClass()}>{t("people.title")}</Link>}
            />
          )}
          {choosing && lines.length > 0 && (
            <FormSection>
              <h2 className="t-md">{t("notice.pick.title")}</h2>
              {dates.map((effectiveDate) => (
                <section key={effectiveDate} aria-label={fmtDate(effectiveDate)}>
                  <h3>{fmtDate(effectiveDate)}</h3>
                  {lines
                    .filter((c) => c.event.effective_date === effectiveDate)
                    .map((c) => (
                      <Check
                        key={c.event.id}
                        checked={selected.includes(c.event.id)}
                        onChange={(checked) => onToggleSelected(c.event.id, checked)}
                      >
                        {c.name} · {label(LIFECYCLE_EVENT, c.event.event_type)} · {after(c)}
                      </Check>
                    ))}
                </section>
              ))}
              {hasNextPage && (
                <Button aria-disabled={isFetchingNextPage || undefined} onClick={onFetchNextPage}>
                  {t("notice.pick.more")}
                </Button>
              )}
            </FormSection>
          )}
          {showForm && (
            <FormSection>
              <h2 className="t-md">
                <FileText size={16} aria-hidden /> {batch ? t("notice.new.of", { count: count ?? 0 }) : t("notice.new.ofEvents", { count: idsLength })}
              </h2>
              <Field label={t("notice.field.title")} required error={tried && gaps.title ? t("notice.missing.title") : undefined}>
                {(p) => <TextInput {...p} maxLength={TITLE_MAX} value={title} onChange={(e) => onTitle(e.target.value)} />}
              </Field>
              <DateField
                label={t("notice.field.date")}
                required
                today={today}
                presets={datePresets(today, ["today"])}
                value={date}
                onChange={onDate}
                echo={date ? t("notice.field.dateEcho") : undefined}
                error={tried && gaps.date ? t("notice.missing.date") : undefined}
                showErrors={tried}
              />
              <Field label={t("notice.field.note")} required={false}>
                {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={memo} onChange={(e) => onMemo(e.target.value)} />}
              </Field>
            </FormSection>
          )}
        </div>
      }
      asideLabel={t("notice.preview.title")}
      aside={
        choosing && lines.length > 0 ? (
          <div ref={asideRef}>
            <FormSection>
              <h2 className="t-md">{t("notice.preview.title")}</h2>
              <Table
                label={t("notice.preview.title")}
                rows={[...picked]}
                rowId={(c) => c.event.id}
                mobileLayout="compact"
                density="compact"
                columns={[
                  { header: t("notice.doc.col.name"), cell: (c) => c.name, card: "fact" },
                  { header: t("notice.doc.col.number"), cell: (c) => c.employee_number ?? "—", card: "omit" },
                  { header: t("notice.doc.col.before"), cell: before, card: "omit" },
                  { header: t("notice.doc.col.after"), cell: after, card: "title" },
                ]}
              />
            </FormSection>
          </div>
        ) : undefined
      }
      notice={
        <CommandError
          error={error}
          own={(code) => (isMessageId(`notice.error.${code}`) ? t(`notice.error.${code}` as never, { no: takenNo }) : undefined)}
        />
      }
      actions={
        !gaps.events ? (
          <Button variant="primary" aria-disabled={pending || undefined} onClick={onSubmit}>
            {t("notice.new.title")}
            <Kbd keys="⌘↵" />
          </Button>
        ) : null
      }
      statusSegments={[
        { id: "scope", tone: "strong", content: t("notice.title") },
        { id: "picked", content: String(idsLength) },
      ]}
    />
  );
}
