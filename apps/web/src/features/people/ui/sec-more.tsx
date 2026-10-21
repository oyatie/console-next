import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Lock, Settings } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { FieldRow } from "../../../ui/record/field-row";
import { Gate, Masked, RecordSection, SectionLine, SubHead } from "../../../ui/record/record-section";
import { restrictedQuery, type RecordEntry } from "../api/record";
import { useEntryRows } from "./entry-rows";
import type { Card } from "./use-card";
import { tx } from "../present";
import s from "./card.module.css";
import { Muted } from "../../../ui/muted/muted";

/** The restricted-read purposes (restricted_record_purpose system codes); none is preselected. */
const PURPOSES = ["STATUTORY_REPORTING", "WORK_ACCOMMODATION", "DISCIPLINARY_PROCEDURE", "RECORD_CORRECTION", "DISPUTE_OR_INSPECTION", "DATA_SUBJECT_ACCESS"] as const;
type F = Record<string, string | boolean | null | undefined>;
/** A family member's name as shown: its first letter, the rest masked. */
const maskName = (name: string) => (Array.from(name)[0] ?? "") + "••";

/**
 * 6 awards and family (E2): award rows, discipline behind a purpose (its existence is never shown), family rows with names
 * masked. Each list has its the list's add and each row edit, the overflow menu history and void (docs/design/record-actions.md §3).
 */
export function SecFamily({ c }: { c: Card }) {
  const [purpose, setPurpose] = useState<string | null>(null);
  const e = useEntryRows(c);
  const discipline = useQuery({ ...restrictedQuery(c.e.id, "discipline", purpose ?? ""), enabled: Boolean(purpose), retry: false });
  const f = (x: RecordEntry) => x.fields as unknown as F;
  const familyName = (x: RecordEntry) => `${tx(`empRec.family.relation.${f(x).relation}`)} ${maskName(String(f(x).name))}`;
  return (
    <RecordSection id="s6" no={6} title={t("empCard.sec.family")} meta={t("empCard.family.meta")}>
      {e.overlays}
      <SubHead tools={e.add("award")}>{t("empCard.family.awards", { count: e.of("award").filter((x) => !x.voided).length })}</SubHead>
      {e.rows("award", [{ cell: (x) => f(x).title as string }, { cell: (x) => <span className={s.num}>{fmtDate(f(x).decided_on as string)}</span> }, { cell: (x) => (f(x).issuer as string) ?? "—" }], (x) => f(x).title as string) ?? <SectionLine>{t("empCard.none")}</SectionLine>}
      {e.editor("award")}
      <FieldRow
        label={t("empCard.family.discipline")}
        mark={
          c.manage && (
            <PopoverButton link label={t("empCard.family.pickPurpose")} trigger={t("empCard.family.pickPurpose")} title={<><Lock size={14} aria-hidden />{t("empCard.family.discipline")}</>}>
              {(close) => <ChipChoice label={t("empCard.purpose.label")} options={PURPOSES.map((p) => ({ value: p, label: t(`empCard.purpose.${p}`) }))} value={purpose} onChange={(p) => (setPurpose(p), close())} />}
            </PopoverButton>
          )
        }
      >
        {!purpose ? (
          <span className={s.lockLine}><Lock size={12} aria-hidden /> {t("empCard.family.disciplineGate")}</span>
        ) : discipline.isError ? (
          <span className={s.warn}>{t("empCard.restricted.denied")}</span>
        ) : (
          t("empCard.family.disciplineOpen", { count: discipline.data?.items.length ?? 0, purpose: tx(`empCard.purpose.${purpose}`) })
        )}
      </FieldRow>
      <SubHead tools={e.add("family")}>{t("empCard.family.family", { count: e.of("family").filter((x) => !x.voided).length })}</SubHead>
      {e.rows("family", [{ cell: (x) => <span className={s.familyItem}>{tx(`empRec.family.relation.${f(x).relation}`)}<Masked>{maskName(String(f(x).name))}</Masked></span> }, { cell: (x) => <span className={s.num}>{f(x).birth_date ? fmtDate(f(x).birth_date as string) : "—"}</span> }], familyName) ?? <SectionLine>{t("empCard.none")}</SectionLine>}
      {e.editor("family")}
    </RecordSection>
  );
}

/** 7 restricted items (E2-restricted): closed until a purpose is picked (no default); the read is logged by the server. */
export function SecRestricted({ c }: { c: Card }) {
  const [purpose, setPurpose] = useState<string | null>(null);
  const sections = c.records.data?.sections ?? [];
  const on = sections.filter((x) => (x.section === "DISABILITY" || x.section === "VETERAN") && x.enabled).length > 0;
  const disability = useQuery({ ...restrictedQuery(c.e.id, "disability", purpose ?? ""), enabled: Boolean(purpose) && on, retry: false });
  const veteran = useQuery({ ...restrictedQuery(c.e.id, "veteran", purpose ?? ""), enabled: Boolean(purpose) && on, retry: false });
  const switchLine = <span className={s.s12}><Settings size={12} aria-hidden /> {t(on ? "empCard.restricted.on" : "empCard.restricted.off")}</span>;
  return (
    <RecordSection id="s7" no={7} title={t("empCard.sec.restricted")} tools={switchLine}>
      {!on ? (
        <SectionLine>{t("empCard.restricted.offLine")}</SectionLine>
      ) : !purpose ? (
        <Gate icon={<Lock size={18} aria-hidden />}>
          <b>{t("empCard.restricted.gate")}</b> <span className={s.s12}>{t("empCard.restricted.law")}</span>
          <ChipChoice label={t("empCard.purpose.label")} options={PURPOSES.map((p) => ({ value: p, label: t(`empCard.purpose.${p}`) }))} value={purpose} onChange={setPurpose} />
        </Gate>
      ) : disability.isError || veteran.isError ? (
        <SectionLine><span className={s.warn}>{t("empCard.restricted.denied")}</span></SectionLine>
      ) : (
        <>
          <SectionLine>{t("empCard.restricted.open", { purpose: tx(`empCard.purpose.${purpose}`) })}</SectionLine>
          <FieldRow label={t("empCard.restricted.disability")}>{disability.data?.items.length ? t("empCard.restricted.recorded") : <Muted>{t("empCard.restricted.none")}</Muted>}</FieldRow>
          <FieldRow label={t("empCard.restricted.veteran")}>{veteran.data?.items.length ? t("empCard.restricted.recorded") : <Muted>{t("empCard.restricted.none")}</Muted>}</FieldRow>
        </>
      )}
    </RecordSection>
  );
}

/**
 * 8 documents (E2): employee documents are not served yet (backend-followups EMP-UI), so no upload control is drawn
 * (record-actions §5: no dead button); the line says what is missing and where the one upload today (the photo) is.
 */
export function SecDocs() {
  return (
    <RecordSection id="s8" no={8} title={t("empCard.sec.docs")}>
      <SectionLine><FileText size={14} aria-hidden /> {t("empCard.docs.unserved")}</SectionLine>
    </RecordSection>
  );
}
