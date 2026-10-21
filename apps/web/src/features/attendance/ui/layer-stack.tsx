import { Check } from "lucide-react";
import { t } from "@console/i18n";
import { ItemList } from "../../../ui/item-list/item-list";
import { SectionHead } from "../../../ui/card/section-head";
import type { Calendar } from "../api";
import { dateText } from "../present";
import s from "./attendance.module.css";

/**
 * Decision order (A2 layer stack): every level from the nearest, what each holds, and the one that wins today, marked
 * with a check and the word "wins" (never colour alone). Layers that start later are listed as scheduled.
 */
export function LayerStack({ calendar }: { calendar: Calendar }) {
  return (
    <section aria-labelledby="att-stack">
      <SectionHead id="att-stack" level={3}>{t("attendanceSchedule.stack.title")}</SectionHead>
      <ItemList
        label={t("attendanceSchedule.stack.title")}
        items={calendar.stack.map((e) => ({
          key: e.level,
          tone: e.wins ? "ok" : undefined,
          mark: e.wins ? <Check size={14} aria-hidden /> : <span className={s.markGap} />,
          text: (
            <>
              <strong>{t(`attendance.level.${e.level}`)} · {e.layer ? e.layer.pattern_name : t("attendanceSchedule.stack.none")}</strong>
              {e.wins && <> · {t("attendanceSchedule.stack.wins")}</>}
              <br />
              <span className="muted">
                {e.layer
                  ? t("attendanceSchedule.stack.layer", { scope: e.scope_name ?? "", from: dateText(e.layer.effective_from), version: e.layer.version })
                  : e.scope_name
                    ? t("attendanceSchedule.stack.noneAt", { scope: e.scope_name })
                    : t("attendanceSchedule.stack.notApplicable")}
              </span>
            </>
          ),
        }))}
      />
      {calendar.upcoming.length > 0 && (
        <ItemList
          label={t("attendanceSchedule.stack.upcoming")}
          items={calendar.upcoming.map((u) => ({ key: u.layer_id, text: t("attendanceSchedule.stack.upcomingLine", { pattern: u.pattern_name, from: dateText(u.effective_from) }), end: t("attendance.state.SCHEDULED") }))}
        />
      )}
    </section>
  );
}
