import { EnumCode } from "../../../ui/enum-value";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, LEAVE_TYPE, LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { PaperGrid, PaperTable } from "../../../ui/paper/paper-table";
import { initial, maskedAddress, maskedBirth, maskedPhone } from "../domain/card";
import { tx, eventWhat } from "../present";
import type { Card } from "./use-card";
import { useCardRegister } from "./use-card-register";
import { Paper, PaperFoot, PaperHead, PaperId } from "../../../ui/paper/paper";

/** The history sections a print carries (awards and family, and the restricted ones are never in it). */
const HISTORY: readonly string[] = ["EDUCATION", "QUALIFICATION", "MILITARY", "LANGUAGE", "TRAINING"];

/**
 * The personnel-record paper (E10-print): photo and identity in a grid, the nine register items (Decree §20), the action history
 * table, history lines; masked values print as masked. Always light (print colours), with the printed-at and purpose line as its foot
 * and a faint preview watermark on screen.
 */
export function PrintPaper({ c, parts, why, at }: { c: Card; parts: readonly string[]; why: string | null; at: string }) {
  const { e, d } = c;
  const r = c.register.data;
  const p = c.personal.data;
  const reg = useCardRegister(c);
  const has = (x: string) => parts.includes(x);
  const k = d.classification;
  const events = (c.events.data?.items ?? []).filter((x) => x.state !== "CANCELLED").sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  const records = (c.records.data?.items ?? []).filter((x) => !x.voided && HISTORY.includes(x.section));
  const phone = (d.employment ?? d.pending_employment)?.phone_e164;
  const reveal = (key: string, v: string) => (key === "birth" ? maskedBirth() : key === "address" && r?.address ? maskedAddress(r.address) : v);
  return (
    <Paper size="a4" label={t("empDoc.print.preview")} watermark={t("empDoc.print.wm", { at: fmtDateTime(at) })}>
      <PaperHead title={t("empDoc.print.paperTitle")}><span className="grow" /><span>{t("empDoc.print.asOf", { entity: c.place.entity, date: fmtDate(todayKst()) })}</span></PaperHead>
      <PaperId photo={c.personal.data?.photo?.url ? t("empDoc.print.photo") : initial(e.name)}>
        <PaperGrid
          rows={[
            [t("empCard.f.name"), [e.name, [p?.name_hanja, p?.name_en].filter(Boolean).join(" · ")].filter(Boolean).join(" (") + (p?.name_hanja || p?.name_en ? ")" : "")],
            [t("empCard.empno.field"), e.employee_number ?? ""],
            [t("empCard.reg.item.sex"), r?.sex ? t(`empCard.sex.${r.sex}`) : ""],
            [t("empCard.f.birth"), c.facts.data?.birth_date ? maskedBirth() : ""],
            [t("empCard.f.address"), r?.address ? maskedAddress(r.address) : ""],
            [t("empCard.f.phone"), phone ? maskedPhone(phone) : ""],
            [t("empDoc.print.place"), [c.place.workplace, ...c.place.path].filter(Boolean).join(" › ")],
            [t("empDoc.print.gradeTitle"), [c.title(k.grade_id) ?? e.position, c.title(k.position_kind_id)].filter(Boolean).join(" · ")],
            [t("empCard.f.hire"), fmtDate(e.hire_date)],
            [t("empCard.f.type"), d.employment?.employment_type ? label(EMPLOYMENT_TYPE, d.employment.employment_type) : ""],
          ]}
        />
      </PaperId>
      {has("register") && <><b>{t("empDoc.print.register")}</b><PaperGrid rows={reg.items.map((i): [string, string] => [`${i.no}. ${t(`empCard.reg.item.${i.key}`)}`, i.present ? reveal(i.key, String(reg.value(i) ?? "")) : t("empDoc.reg.blank")])} /></>}
      {has("personal") && <><b>{t("empCard.sec.personal")}</b><PaperGrid rows={[[t("empCard.f.workEmail"), e.work_email ?? ""], [t("empCard.f.personalEmail"), p?.personal_email ? t("empDoc.print.masked") : ""]]} /></>}
      {has("events") && events.length > 0 && (
        <>
          <b>{t("empCard.tab.events")}</b>
          <PaperTable
            label={t("empCard.tab.events")}
            head={[t("empDoc.print.col.from"), t("empDoc.print.col.act"), t("empDoc.print.col.what")]}
            rows={events.map((x) => ({ id: x.id, cells: [fmtDate(x.effective_date), `${label(LIFECYCLE_EVENT, x.event_type)}${x.state === "SCHEDULED" ? ` ${t("empDoc.print.planned")}` : ""}`, <>{eventWhat(x, c.title) || x.comment || "—"} <EnumCode e={LEAVE_TYPE} value={x.leave_type} /></>] }))}
          />
        </>
      )}
      {has("records") && records.length > 0 && <><b>{t("empDoc.print.part.records")}</b><PaperGrid rows={records.map((x): [string, string] => [tx(`empRec.${x.section.toLowerCase()}`), Object.values(x.fields ?? {}).filter((v) => typeof v === "string").slice(0, 3).join(" · ")])} /></>}
      <PaperFoot>{t("empDoc.print.foot", { at: fmtDateTime(at), purpose: why ? tx(`empDoc.print.purpose.${why}`) : "—" })}</PaperFoot>
    </Paper>
  );
}
