import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";

/** Empty schedule: start with the available schedule or pattern action. */
export function FirstRun({ patterns, people, onSchedule }: { patterns: number; people: number; onSchedule: () => void }) {
  return (
    <Card title={t("attendance.firstRun.title")} meta={t("attendance.firstRun.reason", { people })}>
      <Button variant="primary" onClick={onSchedule}><Plus size={16} aria-hidden /> {t(patterns ? "attendance.firstRun.schedule.action" : "attendance.firstRun.pattern.action")}</Button>
    </Card>
  );
}
