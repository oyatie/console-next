import { Check, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { t } from "@console/i18n";
import { failureText } from "../../../lib/refusal";
import { Banner } from "../../../ui/banner/banner";
import { ItemList, type Item } from "../../../ui/item-list/item-list";
import { SectionHead } from "../../../ui/card/section-head";
import type { AssignPreview as Preview, Pattern } from "../api";
import { duration } from "../domain/minutes";
import { WEEK_LIMIT } from "../domain/pattern";
import { monthText, refusalText } from "../present";

const ok = <Check size={14} aria-hidden />;
const warn = <TriangleAlert size={14} aria-hidden />;
const info = <Info size={14} aria-hidden />;
const bad = <CircleAlert size={14} aria-hidden />;

/** preview before applying: what the server says the assignment would do. Each line leads with its number; nothing is guessed. */
export function AssignPreview({ preview, pending, error, ready, pattern }: { preview?: Preview; pending: boolean; error?: unknown; ready: boolean; pattern?: Pattern }) {
  if (!ready) return <p className="muted">{t("attendanceSchedule.preview.wait")}</p>;
  const lines: Item[] = [];
  if (preview) {
    for (const r of preview.refusals) lines.push({ key: `r-${r.code}-${r.target ?? ""}`, tone: "danger", mark: bad, text: refusalText(r.code) ?? r.code });
    lines.push({
      key: "moved",
      tone: "ok",
      mark: ok,
      text: <><strong>{t("attendanceSchedule.preview.moved", { count: preview.people_changed, pattern: pattern?.name ?? "" })}</strong><br /><span className="muted">{t("attendanceSchedule.preview.inScope", { count: preview.people_in_scope })}</span></>,
    });
    for (const k of preview.kept.filter((x) => x.people > 0))
      lines.push({ key: `kept-${k.level}`, mark: info, text: t("attendanceSchedule.preview.kept", { count: k.people, level: t(`attendance.level.${k.level}`) }) });
    lines.push(
      preview.closed_months.length
        ? { key: "closed", tone: "danger", mark: bad, text: t("attendanceSchedule.preview.closed", { months: preview.closed_months.map(monthText).join(" · ") }) }
        : { key: "closed", tone: "ok", mark: ok, text: t("attendanceSchedule.preview.notClosed") },
    );
    if (preview.past_from) lines.push({ key: "past", tone: "warn", mark: warn, text: t("attendanceSchedule.preview.past") });
    if (preview.night_work) lines.push({ key: "night", tone: "warn", mark: warn, text: <><strong>{t("attendanceSchedule.preview.night")}</strong><br /><span className="muted">{t("attendanceSchedule.preview.nightHint")}</span></> });
    lines.push({
      key: "week",
      tone: preview.weekly_minutes > WEEK_LIMIT ? "danger" : "ok",
      mark: preview.weekly_minutes > WEEK_LIMIT ? bad : ok,
      text: t("attendanceSchedule.preview.week", { week: duration(preview.weekly_minutes) }),
    });
    if (preview.unscheduled_after > 0) lines.push({ key: "left", tone: "warn", mark: warn, text: t("attendanceSchedule.preview.unscheduled", { count: preview.unscheduled_after }) });
  }
  return (
    <section aria-labelledby="att-preview" aria-busy={pending}>
      <SectionHead id="att-preview" level={3}>{t("attendanceSchedule.preview.title")}</SectionHead>
      {error ? <Banner tone="danger" live="polite">{failureText(error, refusalText)}</Banner> : null}
      {preview ? <ItemList label={t("attendanceSchedule.preview.title")} items={lines} /> : <p className="muted" role="status">{t("attendanceSchedule.preview.loading")}</p>}
      {preview && pending && <p className="muted" role="status">{t("attendanceSchedule.preview.updating")}</p>}
    </section>
  );
}
