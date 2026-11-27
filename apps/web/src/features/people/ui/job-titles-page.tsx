import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { JOB_TITLE_KIND, JOB_TITLE_STATUS, label as enumLabel } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { SettingsViewsNav } from "../../../shell/settings-nav";
import { useSettingsViews } from "../../../shell/use-settings-views";
import { Button, Form } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { EmptyState } from "../../../ui/empty-state";
import { EnumValue } from "../../../ui/enum-value";
import { Field, TextInput } from "../../../ui/field/field";
import { StatRow } from "../../../ui/key-value/key-value";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import { FormSection } from "../../../ui/patterns/form-section";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { Table, type Column } from "../../../ui/table";
import { addJobTitle, jobTitleSchemas, jobTitlesQuery, updateJobTitle, type JobTitleKind } from "../api";
import type { JobTitle } from "../domain/titles";
import { JobTitleEdit } from "./job-title-edit";
import sf from "./settings-form.module.css";

const rules = jobTitleSchemas.create.properties;

/**
 * The company's position catalog (BW-13): every title, most senior first, the ones no longer used kept for history.
 * Promotions pick from the active ones and the rank decides a demotion. Who may change the list is the server's
 * (job_title_manage); without it the list is read-only and says who keeps it.
 */
export function JobTitlesPage() {
  const titles = useQuery(jobTitlesQuery);
  const navItems = useSettingsViews();
  const [editingId, setEditingId] = useState<string | null>(null);
  // Who may change the lists is the server's verdict on this user (Cedar job_title_manage, BE-EMP-UI §1).
  const manage = titles.data?.can_manage === true;
  const makeColumns = (onEdit?: (x: JobTitle) => void): Column<JobTitle>[] => [
    { header: t("titles.col.kind"), cell: (x) => enumLabel(JOB_TITLE_KIND, x.kind), card: "fact", width: "status" },
    { header: t("titles.col.label"), cell: (x) => <bdi className={sf.wrap}>{x.label}</bdi>, card: "title", width: "summary" },
    { header: t("titles.col.rank"), cell: (x) => (x.grade_rank === null ? t("titles.unranked") : <span className="num">{x.grade_rank}</span>), width: "code" },
    { header: t("titles.col.state"), cell: (x) => <EnumValue e={JOB_TITLE_STATUS} value={x.active ? "active" : "inactive"} />, width: "status" },
    ...(manage ? [{ header: t("titles.col.actions"), cell: (x: JobTitle) => <Toggle x={x} onEdit={onEdit} />, card: "action" as const }] : []),
  ];
  const editingEntry = titles.data?.items.find((x) => x.id === editingId) ?? null;

  const renderBaseline = () => (
    <div className="page">
      <div className="page__head">
        <Link to="/people" search={{}} className="btn btn--ghost">{t("people.title")}</Link>
        <h1 className="page__title grow">{t("titles.title")}</h1>
      </div>
      <QueryState q={titles} layout="list">
        {() => (
          <>
            <AddTitle manage={manage} />
            <section className="card" aria-labelledby="titles-list">
              <h2 id="titles-list" className="panel__title">{t("titles.list")}</h2>
              {titles.data!.items.length ? <Table mobileLayout="cards" label={t("titles.list")} rows={titles.data!.items} rowId={(x) => x.id} columns={makeColumns()} /> : <EmptyState title={t("titles.none.title")} reason={t(manage ? "titles.none.manage" : "titles.none.read")} />}
            </section>
          </>
        )}
      </QueryState>
    </div>
  );

  return (
    <SettingsPattern
      q={titles}
      baseline={renderBaseline}
      head={{
        title: t("titles.title"),
        tools: <Link to="/people" search={{}} className={buttonClass("secondary", { size: "sm" })}>{t("people.title")}</Link>,
      }}
      views={navItems.length > 0 ? <SettingsViewsNav items={navItems} current="/people/job-titles" /> : undefined}
      summary={
        titles.data ? (
          <StatRow
            label={t("titles.title")}
            items={[
              { key: "total", label: t("titles.list"), value: fmtNumber(titles.data.items.length) },
              { key: "active", label: t("titles.active"), value: fmtNumber(titles.data.items.filter((x) => x.active).length), tone: "ok" },
              { key: "inactive", label: t("titles.inactive"), value: fmtNumber(titles.data.items.filter((x) => !x.active).length), tone: "muted" },
            ]}
          />
        ) : undefined
      }
      panel={
        titles.data ? (
          <>
            <AddTitle manage={manage} consoleMode />
            <section aria-labelledby="titles-list">
              <PaneHead titleId="titles-list" title={t("titles.list")} level={2} />
              {titles.data.items.length ? (
                <Table scrollLayout="auto" mobileLayout="cards" label={t("titles.list")} rows={titles.data.items} rowId={(x) => x.id} columns={makeColumns((x) => setEditingId(x.id))} />
              ) : (
                <FormSection>
                  <EmptyState title={t("titles.none.title")} reason={t(manage ? "titles.none.manage" : "titles.none.read")} />
                </FormSection>
              )}
            </section>
          </>
        ) : null
      }
      record={
        manage && editingEntry
          ? {
              id: `edit-${editingEntry.id}`,
              label: t("titles.edit.title", { label: editingEntry.label }),
              title: t("titles.edit.title", { label: editingEntry.label }),
              onClose: () => setEditingId(null),
              returnFocus: () => document.getElementById(`jt-edit-${editingEntry.id}`),
              children: <FormSection><JobTitleEdit key={editingEntry.id} entry={editingEntry} onClose={() => setEditingId(null)} /></FormSection>,
            }
          : undefined
      }
      statusSegments={
        titles.data
          ? [
              { id: "scope", tone: "strong", content: t("titles.title") },
              { id: "count", content: fmtNumber(titles.data.items.length) },
            ]
          : undefined
      }
    />
  );
}

/** Ranks are kept for the GRADE and TITLE lists only (MR-25); the server refuses one on another list. */
const RANKED: readonly JobTitleKind[] = ["GRADE", "TITLE"];

/**
 * A new entry on one of the five lists, chosen first (nothing preselected), and its optional rank (higher is more
 * senior); adding a label the list already has is harmless.
 */
function AddTitle({ manage, consoleMode = false }: { manage: boolean; consoleMode?: boolean }) {
  const [kind, setKind] = useState<JobTitleKind | null>(null);
  const [label, setLabel] = useState("");
  const [rank, setRank] = useState("");
  const [tried, setTried] = useState(false);
  const ranked = kind !== null && RANKED.includes(kind);
  const n = rank === "" || !ranked ? null : Number(rank);
  const bad = n !== null && (!Number.isInteger(n) || n < rules.grade_rank.minimum || n > rules.grade_rank.maximum);
  const run = useCommand({
    run: () => addJobTitle({ kind: kind!, label: label.trim(), grade_rank: n }),
    invalidates: ["/api/v1/job-titles"],
    onSuccess: () => (setLabel(""), setRank(""), setTried(false)),
  });
  const form = manage ? (
    <Form
      className={consoleMode ? `form ${sf.narrowFields}` : "card panel form"}
      aria-labelledby={consoleMode ? "titles-add" : undefined}
      noValidate
      onSubmit={() => {
        setTried(true);
        if (kind && label.trim() && !bad) run.mutate(undefined);
      }}
    >
      {!consoleMode && <h2 className="panel__title">{t("titles.add")}</h2>}
      <ChoiceField
        label={t("titles.col.kind")}
        required
        options={JOB_TITLE_KIND.values.map((v) => ({ value: v, label: enumLabel(JOB_TITLE_KIND, v) }))}
        value={kind}
        onChange={(v) => (run.reset(), setKind(v as JobTitleKind))}
        error={tried && !kind ? t("titles.kind.missing") : undefined}
      />
      <div className="grid-3">
        <Field label={t("titles.col.label")} required error={tried && !label.trim() ? t("titles.label.missing") : undefined}>
          {(p) => <TextInput {...p} value={label} maxLength={rules.label.maxLength} onChange={(e) => (run.reset(), setLabel(e.target.value))} />}
        </Field>
        {ranked && <Field label={t("titles.col.rank")} required={false} hint={t("titles.rank.hint", { min: rules.grade_rank.minimum, max: rules.grade_rank.maximum })} error={bad ? t("titles.rank.bad", { min: rules.grade_rank.minimum, max: rules.grade_rank.maximum }) : undefined}>
          {(p) => <TextInput {...p} className="num" inputMode="numeric" value={rank} onChange={(e) => setRank(e.target.value.replace(/\D/g, ""))} />}
        </Field>}
      </div>
      <CommandError error={run.error} />
      <div className="form__actions">
        <Button type="submit" variant="primary" aria-disabled={run.isPending || undefined}>{t("titles.add.commit")}</Button>
      </div>
    </Form>
  ) : null;
  const statusNode = (run.isSuccess || !manage) ? (
    <p role="status">{manage ? t(run.data?.active ? "titles.added" : "people.title.inactive", { label: run.data?.label ?? "" }) : t("empFix.catalog.denied", { field: t("titles.list") })}</p>
  ) : null;

  if (consoleMode) {
    return (
      <>
        {statusNode ? <FormSection>{statusNode}</FormSection> : null}
        {form ? (
          <section aria-labelledby="titles-add">
            <PaneHead titleId="titles-add" title={t("titles.add")} level={2} />
            <FormSection>{form}</FormSection>
          </section>
        ) : null}
      </>
    );
  }
  return (
    <>
      {statusNode}
      {form}
    </>
  );
}

/** Stops or resumes offering a title to new promotions; history and scheduled promotions keep resolving it. */
function Toggle({ x, onEdit }: { x: JobTitle; onEdit?: (x: JobTitle) => void }) {
  const [edit, setEdit] = useState(false);
  const run = useCommand({ run: () => updateJobTitle(x.id, { active: !x.active }), invalidates: ["/api/v1/job-titles"] });
  const toggleKey = x.active ? "deactivate" : "activate";
  return (
    <>
      <Button
        id={onEdit ? `jt-edit-${x.id}` : undefined}
        size={onEdit ? "sm" : undefined}
        variant="ghost"
        aria-label={onEdit ? t("titles.edit", { label: x.label }) : undefined}
        onClick={() => (onEdit ? onEdit(x) : setEdit(true))}
      >
        {onEdit ? t("titles.action.edit") : t("titles.edit", { label: x.label })}
      </Button>
      {!onEdit && edit && <JobTitleEdit entry={x} onClose={() => setEdit(false)} />}
      <Button
        size={onEdit ? "sm" : undefined}
        variant="ghost"
        aria-label={onEdit ? t(`titles.${toggleKey}`, { label: x.label }) : undefined}
        onClick={() => run.mutate(undefined)}
        aria-disabled={run.isPending || undefined}
      >
        {onEdit ? t(`titles.action.${toggleKey}`) : t(`titles.${toggleKey}`, { label: x.label })}
      </Button>
      <CommandError error={run.error} />
    </>
  );
}
