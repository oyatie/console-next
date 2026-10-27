import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Form } from "../../../ui/button/button";
import { EnumValue } from "../../../ui/enum-value";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { Table, type Column } from "../../../ui/table";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { JOB_TITLE_KIND, JOB_TITLE_STATUS, label as enumLabel } from "../../../lib/labels";
import { addJobTitle, jobTitlesQuery, updateJobTitle, type JobTitleKind } from "../api";
import { JobTitleEdit } from "./job-title-edit";
import type { JobTitle } from "../domain/titles";

const LABEL_MAX = 100;
const RANK_MAX = 1000;

/**
 * The company's position catalog (BW-13): every title, most senior first, the ones no longer used kept for history.
 * Promotions pick from the active ones and the rank decides a demotion. Who may change the list is the server's
 * (job_title_manage); without it the list is read-only and says who keeps it.
 */
export function JobTitlesPage() {
  const titles = useQuery(jobTitlesQuery);
  // Who may change the lists is the server's verdict on this user (Cedar job_title_manage, BE-EMP-UI §1).
  const manage = titles.data?.can_manage === true;
  const columns: Column<JobTitle>[] = [
    { header: t("titles.col.kind"), cell: (x) => enumLabel(JOB_TITLE_KIND, x.kind), fit: true },
    { header: t("titles.col.label"), cell: (x) => x.label, wide: true },
    { header: t("titles.col.rank"), cell: (x) => (x.grade_rank === null ? t("titles.unranked") : <span className="num">{x.grade_rank}</span>), fit: true },
    { header: t("titles.col.state"), cell: (x) => <EnumValue e={JOB_TITLE_STATUS} value={x.active ? "active" : "inactive"} />, fit: true },
    ...(manage ? [{ header: t("titles.col.actions"), cell: (x: JobTitle) => <Toggle x={x} />, fit: true }] : []),
  ];
  return (
    <div className="page">
      <div className="page__head">
        <Link to="/people" search={{}} className="btn btn--ghost">{t("people.title")}</Link>
        <h1 className="page__title grow">{t("titles.title")}</h1>
      </div>
      <QueryState q={titles} layout="list">{() => <>
      {/* Nothing below the head until the read says who may change the lists: the add form would push the list down. */}
      {
        <>
          <AddTitle manage={manage} />
          <section className="card" aria-labelledby="titles-list">
            <h2 id="titles-list" className="panel__title">{t("titles.list")}</h2>
            {titles.data!.items.length ? <Table label={t("titles.list")} rows={titles.data!.items} rowId={(x) => x.id} columns={columns} /> : <EmptyState title={t("titles.none.title")} reason={t(manage ? "titles.none.manage" : "titles.none.read")} />}
          </section>
        </>
      }
    </>}</QueryState>
    </div>
  );
}

/** Ranks are kept for the GRADE and TITLE lists only (MR-25); the server refuses one on another list. */
const RANKED: readonly JobTitleKind[] = ["GRADE", "TITLE"];

/**
 * A new entry on one of the five lists, chosen first (nothing preselected), and its optional rank (higher is more
 * senior); adding a label the list already has is harmless.
 */
function AddTitle({ manage }: { manage: boolean }) {
  const [kind, setKind] = useState<JobTitleKind | null>(null);
  const [label, setLabel] = useState("");
  const [rank, setRank] = useState("");
  const [tried, setTried] = useState(false);
  const ranked = kind !== null && RANKED.includes(kind);
  const n = rank === "" || !ranked ? null : Number(rank);
  const bad = n !== null && (!Number.isInteger(n) || n < 0 || n > RANK_MAX);
  const run = useCommand({
    run: () => addJobTitle({ kind: kind!, label: label.trim(), grade_rank: n }),
    invalidates: ["/api/v1/job-titles"],
    onSuccess: () => (setLabel(""), setRank(""), setTried(false)),
  });
  return <>
    {(run.isSuccess || !manage) && <p role="status">{manage ? t(run.data?.active ? "titles.added" : "people.title.inactive", { label: run.data?.label ?? "" }) : t("empFix.catalog.denied", { field: t("titles.list") })}</p>}
    {manage && <Form
      className="card panel form"
      noValidate
      onSubmit={() => {
        setTried(true);
        if (kind && label.trim() && !bad) run.mutate(undefined);
      }}
    >
      <h2 className="panel__title">{t("titles.add")}</h2>
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
          {(p) => <TextInput {...p} value={label} maxLength={LABEL_MAX} onChange={(e) => (run.reset(), setLabel(e.target.value))} />}
        </Field>
        {ranked && <Field label={t("titles.col.rank")} required={false} hint={t("titles.rank.hint", { max: RANK_MAX })} error={bad ? t("titles.rank.bad", { max: RANK_MAX }) : undefined}>
          {(p) => <TextInput {...p} className="num" inputMode="numeric" value={rank} onChange={(e) => setRank(e.target.value.replace(/\D/g, ""))} />}
        </Field>}
      </div>
      <CommandError error={run.error} />
      <div className="form__actions">
        <Button type="submit" variant="primary" aria-disabled={run.isPending || undefined}>{t("titles.add.commit")}</Button>
      </div>
    </Form>}
  </>;
}

/** Stops or resumes offering a title to new promotions; history and scheduled promotions keep resolving it. */
function Toggle({ x }: { x: JobTitle }) {
  const [edit, setEdit] = useState(false);
  const run = useCommand({ run: () => updateJobTitle(x.id, { active: !x.active }), invalidates: ["/api/v1/job-titles"] });
  return (
    <>
      <Button variant="ghost" onClick={() => setEdit(true)}>{t("titles.edit", { label: x.label })}</Button>
      {edit && <JobTitleEdit entry={x} onClose={() => setEdit(false)} />}
      <Button variant="ghost" onClick={() => run.mutate(undefined)} aria-disabled={run.isPending || undefined}>{t(x.active ? "titles.deactivate" : "titles.activate", { label: x.label })}</Button>
      <CommandError error={run.error} />
    </>
  );
}
