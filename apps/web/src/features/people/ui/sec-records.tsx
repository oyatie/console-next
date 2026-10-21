import { useState } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { RecordSection, SectionLine, SubHead } from "../../../ui/record/record-section";
import { RecordRows } from "../../../ui/record/rows";
import { ListAdd, RowActions } from "../../../ui/record-actions/record-actions";
import { correctEmployee } from "../api";
import { ROW_SPEC, fromFields, toFields, type Segment } from "../domain/record-spec";
import type { RecordEntry } from "../api/record";
import { RowEditor } from "./row-editor";
import { useEntryRows } from "./entry-rows";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";
import { tx } from "../present";
import s from "./card.module.css";

type Career = components["schemas"]["EmployeeCareer"];
type F = Record<string, string | number | boolean | null | undefined>;
const v = (x: RecordEntry) => x.fields as unknown as F;
const d = (x: string | null | undefined) => (x ? fmtDate(x) : "");
const span = (a?: unknown, b?: unknown) => [d(a as string), d(b as string)].filter(Boolean).join(" ~ ") || "—";
const word = (section: string, key: string, value: unknown) => (value ? tx(`empRec.${section}.${key}.${String(value)}`) : "");

/**
 * 5 history (E2): career (register item 5), education, licences, military, languages, training. Each sub-list has its
 * the list's add (Enter = next row) and each row its edit, the overflow menu history and void (docs/design/record-actions.md §3). A career
 * row lives in the register facts: edit and delete (setup) or void replace the list; the correction ledger keeps the old one.
 */
export function SecRecords({ c, quick }: { c: Card; quick: Quick }) {
  const [career, setCareer] = useState<{ at: number | null } | null>(null);
  const e = useEntryRows(c);
  const careers = c.register.data?.careers ?? null;
  const careerLabel = t("empRec.career");
  // A career period is by month (YYYY-MM), shown as stored.
  const months = (x: Career) => [x.from, x.to].filter(Boolean).join(" ~ ");
  const careerName = (x: Career) => `${x.employer_name} ${months(x)}`;
  // The list is written at the version of the read that drew it (the register facts' updated_at), so a row edited or
  // deleted right after its add goes past that add even while the card's own read of the employee is still in flight.
  const at = c.register.data?.updated_at ?? c.e.updated_at;
  // An added row is a quick edit; an edited one sends the why its editor asked (the ledger's reason, in either phase).
  const saveCareers = (next: Career[], why = "QUICK_EDIT") => correctEmployee(c.e.id, at, { careers: next as never }, why);
  const careerEditor = career && (
    <RowEditor
      key={career.at ?? "new"}
      section="career"
      spec={ROW_SPEC.career!}
      reads="/api/v1/employees/{id}/register-facts"
      path={c.setup ? "setup" : "correction"}
      initial={career.at === null ? undefined : fromFields(ROW_SPEC.career!, careers![career.at])}
      onClose={() => setCareer(null)}
      onSave={(row, _key, why) => {
        const one = toFields(ROW_SPEC.career!, row) as unknown as Career;
        return saveCareers(career.at === null ? [...(careers ?? []), one] : (careers ?? []).map((x, i) => (i === career.at ? one : x)), why);
      }}
    />
  );
  const head = (sec: Segment, count: number) => <SubHead tools={e.add(sec)}>{tx(`empRec.${sec}.head`, { count })}</SubHead>;
  return (
    <RecordSection id="s5" no={5} title={t("empCard.sec.records")} meta={t("empRec.meta")}>
      {e.overlays}
      <SubHead tools={c.manage && <ListAdd object={careerLabel} onAdd={() => setCareer({ at: null })} />}>{tx("empRec.career.head", { count: careers?.length ?? 0 })}</SubHead>
      {careers?.length ? (
        <RecordRows
          label={careerLabel}
          rows={careers}
          rowId={(x) => `${x.employer_name}${x.from}`}
          columns={[
            { header: t("empRec.career.employer_name"), cell: (x) => x.employer_name },
            { header: t("empRec.career.period"), cell: (x) => <span className={s.num}>{months(x)}</span> },
            { header: t("empRec.career.position"), cell: (x) => x.position ?? "—" },
            { header: t("empRec.career.duty"), cell: (x) => x.duty ?? "—" },
            { header: t("empRec.career.leave_reason"), cell: (x) => x.leave_reason ?? "—" },
            {
              end: true,
              cell: (x) =>
                c.manage && (
                  <RowActions
                    field={careerName(x)}
                    onEdit={() => setCareer({ at: careers.indexOf(x) })}
                    path={c.setup ? "setup" : "correction"}
                    end={{ verb: c.setup ? "delete" : "void", onPress: () => quick.save(careerLabel, { careers: careers.filter((y) => y !== x) as never }, { careers: careers as never }, at) }}
                  />
                ),
            },
          ]}
        />
      ) : (
        <SectionLine>{careers ? t("empRec.career.none") : <span className={s.warn}>{t("empRec.career.missing")}</span>}</SectionLine>
      )}
      {careerEditor}
      {head("education", e.of("education").length)}
      {e.rows("education", [
        { cell: (x) => v(x).school as string },
        { cell: (x) => [word("education", "level", v(x).level), v(x).major].filter(Boolean).join(" · ") },
        { cell: (x) => <span className={s.num}>{span(v(x).entered_on, v(x).ended_on)}</span> },
        { cell: (x) => word("education", "status", v(x).status) },
      ], (x) => v(x).school as string)}
      {e.editor("education")}
      {head("qualification", e.of("qualification").length)}
      {e.rows("qualification", [
        { header: t("empRec.qualification.name"), cell: (x) => v(x).name as string },
        { header: t("empRec.qualification.kind"), cell: (x) => word("qualification", "kind", v(x).kind) },
        { header: t("empRec.qualification.issuer"), cell: (x) => (v(x).issuer as string) ?? "—" },
        { header: t("empRec.qualification.acquired_on"), cell: (x) => <span className={s.num}>{d(v(x).acquired_on as string) || "—"}</span> },
        { header: t("empRec.qualification.expires_on"), cell: (x) => <span className={s.num}>{d(v(x).expires_on as string) || t("empCard.none")}</span> },
      ], (x) => v(x).name as string)}
      {e.editor("qualification")}
      <SubHead tools={<>{e.add("military")}{e.add("language")}{e.add("training")}</>}>{t("empRec.misc.head")}</SubHead>
      {e.rows("military", [{ cell: () => t("empRec.military") }, { cell: (x) => [word("military", "status", v(x).status), word("military", "branch", v(x).branch), v(x).rank, span(v(x).served_from, v(x).served_to)].filter(Boolean).join(" · ") }], () => t("empRec.military"))}
      {e.rows("language", [{ cell: () => t("empRec.language") }, { cell: (x) => [v(x).language, v(x).test, v(x).score, d(v(x).taken_on as string)].filter(Boolean).join(" · ") }], (x) => v(x).language as string)}
      {e.rows("training", [{ cell: () => t("empRec.training") }, { cell: (x) => [v(x).course, v(x).provider, word("training", "status", v(x).status), span(v(x).started_on, v(x).ended_on)].filter(Boolean).join(" · ") }], (x) => v(x).course as string)}
      {e.of("military").length + e.of("language").length + e.of("training").length === 0 && <SectionLine>{t("empRec.misc.none")}</SectionLine>}
      {e.editor("military")}
      {e.editor("language")}
      {e.editor("training")}
    </RecordSection>
  );
}
