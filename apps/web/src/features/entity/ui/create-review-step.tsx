import { useQuery } from "@tanstack/react-query";
import { Building2, Check, Circle, ClipboardPaste, Info, Plus, TriangleAlert } from "lucide-react";
import type { OrgStructureNode } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { BIZ_KIND, label, TAX_TYPE } from "../../../lib/labels";
import { FORMATS } from "../../../lib/pure/formats";
import { orgStructureRef } from "../../../reference/entity/api";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { isFounding, type WizardStep } from "../domain/create";
import type { CreateState } from "./use-create";
import s from "./entity-create.module.css";
import { Muted } from "../../../ui/muted/muted";

type Row = { key: string; step: WizardStep; title: string; text: string; state: "ok" | "warn" | "todo" };

/** The last step (spec S4-review): what appears on the chart, everything typed with a way back, and what comes next. */
export function ReviewStep({ c, goTo }: { c: CreateState; goTo: (s: WizardStep) => void }) {
  const d = c.draft;
  const corp = d.bizKind === "CORPORATION";
  const founding = isFounding(d);
  const rows: Row[] = [
    { key: "basics", step: "basics", title: t("entityCreate.review.basics"), text: [d.bizKind && label(BIZ_KIND, d.bizKind), d.name.trim(), d.displayName.trim() && t("entityCreate.review.short", { name: d.displayName.trim() })].filter(Boolean).join(" · "), state: "ok" },
    ...(founding ? [] : [{
      key: "certificate", step: "certificate" as const, title: t(d.bizKind === "ID_NUMBER_ORG" ? "entityCreate.step.idCert" : "entityCreate.step.certificate"),
      text: [d.brn && FORMATS.bizRegNo.display(d.brn), d.taxType && label(TAX_TYPE, d.taxType), d.openedOn && t("entityCreate.review.opened", { date: fmtDate(d.openedOn) }), d.businessAddress?.road, d.businessTypes.filter((b) => b.sector.trim()).map((b) => `${b.sector}/${b.item}`).join(", ")].filter(Boolean).join(" · ") || t("entityCreate.review.empty"),
      state: c.registers ? ("ok" as const) : ("todo" as const),
    }]),
    // company-08: a entity being founded has no certificate yet; it is typed when it arrives.
    ...(founding ? [{ key: "founding", step: "registry" as const, title: t("entityOps.founding.chip"), text: t("entityOps.founding.review"), state: "todo" as const }] : []),
    ...(c.crnWarn ? [{ key: "crn", step: "certificate" as const, title: t("entityCreate.field.crn"), text: t("entityCreate.review.crnWarn", { crn: FORMATS.corpRegNo.display(d.crn) }), state: "warn" as const }] : []),
    ...(d.bizKind !== "ID_NUMBER_ORG" && d.unitTaxation === null ? [{ key: "unit", step: "certificate" as const, title: t("entityCreate.field.unitTaxation"), text: t("entityCreate.review.unitTodo"), state: "warn" as const }] : []),
    ...(corp ? [{ key: "registry", step: "registry" as const, title: t("entityCreate.step.registry"), text: registryText(c), state: "ok" as const }] : []),
    { key: "original", step: "certificate", title: t("entityCreate.original.title"), text: c.doc ? t("entityCreate.review.kept", { name: c.doc.file_name }) : t("entityCreate.review.noOriginal"), state: c.doc ? "ok" : "todo" },
  ];
  const todos = rows.filter((r) => r.state !== "ok").length;
  return (
    <div className={s.reviewLayout}>
      <div className={s.col}>
        <section className="card" aria-labelledby="preview-title">
          <div className={s.cardHead}><h2 id="preview-title" className={s.cardTitle}>{t("entityCreate.review.preview")}</h2><span className={s.legend}><i aria-hidden />{t("entityCreate.review.new")}</span></div>
          <Preview c={c} />
        </section>
        <section className="card" aria-labelledby="typed-title">
          <div className={s.cardHead}><h2 id="typed-title" className={s.cardTitle}>{t("entityCreate.review.typed")}</h2><Muted>{t("entityCreate.review.typedHint")}</Muted></div>
          <ul className={s.reviewRows}>
            {rows.map((r) => (
              <li key={r.key}>
                {r.state === "ok" ? <Check size={16} aria-hidden className={s.okMark} /> : r.state === "warn" ? <TriangleAlert size={16} aria-hidden className={s.warnMark} /> : <Circle size={16} aria-hidden className={s.mark} />}
                <b>{r.title}</b>
                <Muted>{r.text}</Muted>
                <Button variant="ghost" aria-label={t("entityCreate.review.editOf", { what: r.title })} onClick={() => goTo(r.step)}>{t("entityCreate.review.edit")}</Button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className={`card ${s.side}`} aria-labelledby="next-title">
        <div className={s.cardHead}><h2 id="next-title" className={s.cardTitle}>{t("entityCreate.review.next")}</h2></div>
        <div className={s.cardBody}>
          {/* company-30: the foot's primary already adds the first workplace; this card only says what follows. */}
          <div className={s.nextCard}>
            <Plus size={18} aria-hidden /><b>{t("entityCreate.review.firstWorkplace")}</b><Muted>{t("entityCreate.review.firstWorkplaceHint")}</Muted>
          </div>
          {/* company-10: pasting many workplace works once the entity exists (the chart's paste); never called "coming soon". */}
          <div className={s.nextCard}>
            <ClipboardPaste size={18} aria-hidden /><b>{t("entityCreate.review.paste")}</b>
          </div>
          <p className={s.note}><Info size={14} aria-hidden /> {todos ? t("entityCreate.review.todos", { count: todos }) : t("entityCreate.review.noTodos")}</p>
        </div>
      </section>
    </div>
  );
}

function registryText(c: CreateState) {
  const d = c.draft;
  const reps = d.representatives.filter((n) => n.trim());
  const parts = [
    reps.length ? reps.join(", ") : t("entityCreate.review.noRep"),
    d.incorporatedOn && t("entityCreate.review.incorporated", { date: fmtDate(d.incorporatedOn) }),
    d.capitalWon && t("entity.won", { amount: fmtNumber(Number(d.capitalWon)) }),
    d.fiscalYearEndMonth && t("entityCreate.review.fiscal", { m: d.fiscalYearEndMonth }),
    d.directors.length ? t("entityCreate.review.directors", { count: d.directors.length }) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

const count = (n: OrgStructureNode, kind: OrgStructureNode["kind"]): number => n.children.reduce((a, x) => a + (x.kind === kind ? 1 : 0) + count(x, kind), 0);

/** "All" (never the account's name, decision #29), its entities as they are, and the new one marked "new" (a text tag, never colour alone). */
function Preview({ c }: { c: CreateState }) {
  const tree = useQuery(orgStructureRef).data;
  const ents = tree?.entities ?? [];
  const total = ents.reduce((a, e) => a + e.headcount, 0);
  const sites = ents.reduce((a, e) => a + count(e, "WORKPLACE") + count(e, "SITE"), 0);
  const depts = ents.reduce((a, e) => a + count(e, "DEPARTMENT"), 0);
  return (
    <div className={s.preview}>
      <div className={s.root}>
        <span className={s.rootLine}><b>{t("entityCreate.review.rootKicker")}</b><b className="num">{t("entityCreate.review.people", { count: total })}</b></span>
        <Muted>{t("entityCreate.review.rootCounts", { entities: ents.length, sites, depts })}</Muted>
      </div>
      <ul className={s.kids}>
        {ents.map((e) => <li key={e.id} className={s.kid}><b>{e.name}</b><span className="num">{fmtNumber(e.headcount)}</span></li>)}
        <li className={`${s.kid} ${s.newKid}`}>
          <Muted><Building2 size={14} aria-hidden /> {c.draft.brn ? t("entityCreate.review.kicker", { brn: `${FORMATS.bizRegNo.display(c.draft.brn).slice(0, 7)}*****` }) : t("entityCreate.review.kickerNone")}</Muted>
          <span className={s.rootLine}><b>{c.draft.name.trim()}</b><Chip tone="ok">{t("entityCreate.review.new")}</Chip><b className="num">{t("entityCreate.review.people", { count: 0 })}</b></span>
          {c.draft.representatives[0]?.trim() && <span>{t("entityCreate.review.rep", { name: c.draft.representatives[0].trim() })}</span>}
          <Muted>{t("entityCreate.review.kidCounts")}</Muted>
          <span className="row"><Chip tone="warn">{t("entityCreate.review.needsWorkplace")}</Chip>{!c.registers && <Chip tone="warn">{t("entityCreate.review.noCert")}</Chip>}</span>
        </li>
      </ul>
    </div>
  );
}
