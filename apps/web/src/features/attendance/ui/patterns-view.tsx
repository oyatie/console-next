import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { patternsQuery, retirePattern, type Pattern } from "../api";
import { duration } from "../domain/minutes";
import { patternShape, peopleText, refusalText } from "../present";

/** A2-types: the work pattern the company uses, how many people each decides today, and retire. */
export function PatternsView({ onAdd, onRetired }: { onAdd: () => void; onRetired: (name: string) => void }) {
  const [retired, setRetired] = useState(false);
  const q = useQuery(patternsQuery(retired));
  const retire = useCommand({ run: (p: Pattern) => retirePattern(p.id), invalidates: ["/api/v1/attendance"], onSuccess: (p) => onRetired(p.name) });
  const rows = (q.data?.items ?? []).filter((p) => retired || p.status === "ACTIVE");
  return (
    <>
      <Card
        title={t("attendancePatterns.types.title")}
        meta={t("attendancePatterns.types.meta")}
        flush
        tools={
          <>
            <ToggleButton size="sm" pressed={retired} onClick={() => setRetired(!retired)}>{t("attendancePatterns.types.showRetired")}</ToggleButton>
            <Button size="sm" variant="primary" onClick={onAdd}><Plus size={16} aria-hidden /> {t("attendancePatterns.types.add")}</Button>
          </>
        }
      >
        <CommandError error={retire.error} own={refusalText} />
        <QueryState q={q} empty={() => (rows.length ? null : <EmptyState title={t("attendancePatterns.types.none")} reason={t("attendancePatterns.types.none.reason")} actions={<Button variant="primary" onClick={onAdd}>{t("attendancePatterns.types.add")}</Button>} />)}>
          {() => (
            <Table
              label={t("attendancePatterns.types.title")}
              rows={rows}
              rowId={(p) => p.id}
              columns={[
                { header: t("attendancePatterns.types.col.kind"), cell: (p) => t(`attendancePatterns.kind.${p.kind}`), fit: true },
                { header: t("attendancePatterns.types.col.name"), cell: (p) => <><strong>{p.name}</strong><br /><span className="muted">{patternShape(p)}</span></> },
                { header: t("attendancePatterns.types.col.people"), cell: (p) => <span className="num">{peopleText(p.people_today)}</span>, fit: true },
                { header: t("attendancePatterns.types.col.week"), cell: (p) => <span className="num">{duration(p.weekly_minutes)}</span>, fit: true },
                { header: t("attendancePatterns.types.col.cycle"), cell: (p) => t("attendancePatterns.types.cycle", { days: p.cycle_days }), fit: true },
                { header: t("attendancePatterns.types.col.notes"), cell: (p) => [p.night_work && t("attendancePatterns.types.night"), t(`attendancePatterns.holidayRule.${p.holiday_rule}`)].filter(Boolean).join(" · ") },
                { header: t("attendancePatterns.types.col.state"), cell: (p) => <Chip tone={p.status === "ACTIVE" ? "ok" : "neutral"}>{t(`attendancePatterns.patternStatus.${p.status}`)}</Chip>, fit: true },
                {
                  header: t("attendancePatterns.types.col.actions"),
                  fit: true,
                  cell: (p) => (p.status === "ACTIVE" ? <Button size="sm" variant="ghost" disabled={retire.isPending} onClick={() => retire.mutate(p)} aria-label={t("attendancePatterns.types.retireOne", { name: p.name })}>{t("attendancePatterns.types.retire")}</Button> : null),
                },
              ]}
            />
          )}
        </QueryState>
      </Card>
    </>
  );
}
