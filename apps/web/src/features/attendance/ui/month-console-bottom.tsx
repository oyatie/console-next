// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { MonthGridBottomSplit, MonthGridEmptyCell } from "../../../ui/patterns/month-grid-parts";
import { Table } from "../../../ui/table";
import { GLYPH } from "../domain/day";
import type { OpenIssueRow } from "../domain/month-console-summary";
import s from "./records.module.css";

function recognitionSummary(item: OpenIssueRow): string {
  if (item.tone === "danger") return t("attendance.monthConsole.bottom.blocksClose");
  if (item.mark === "ABSENT") return t("attendance.monthConsole.bottom.notWorkedDay");
  return t("attendance.monthConsole.bottom.countedInRecognised");
}

function statusChip(item: OpenIssueRow) {
  if (item.tone === "danger") return <Chip tone="danger">{t("attendance.monthConsole.bottom.blockingShort")}</Chip>;
  if (item.tone === "warn") return <Chip tone="warn">{t("attendance.monthConsole.bottom.decisionShort")}</Chip>;
  return <Chip tone="info">{t("attendance.monthConsole.bottom.infoShort")}</Chip>;
}

/**
 * Lower split panel for Console `/attendance` Month (`P5` `bottom`): open exceptions derived from loaded rows
 * alongside the recognition basis (`attendanceRecords.recognition.basis`) and concise mark legend.
 */
export function MonthConsoleBottom({
  issues,
  selectedKey,
  onInspect,
}: {
  issues: readonly OpenIssueRow[];
  selectedKey?: string;
  onInspect: (item: OpenIssueRow) => void;
}) {
  const shown = issues.slice(0, 12);
  const byKey = new Map(shown.map(item => [item.key, item]));

  return (
    <MonthGridBottomSplit
      toggleLabel={t("attendance.monthConsole.bottom.toggleSummary", { count: issues.length })}
      expandLabel={t("attendance.monthConsole.bottom.expand")}
      collapseLabel={t("attendance.monthConsole.bottom.collapse")}
      issuesTitle={t("attendance.monthConsole.bottom.issuesTitle")}
      issuesMeta={t("attendance.count", { count: issues.length })}
      issuesContent={
        shown.length === 0 ? (
          <MonthGridEmptyCell>
            <bdi className="t-sm muted">{t("attendance.issues.empty")}</bdi>
          </MonthGridEmptyCell>
        ) : (
          <Table
            label={t("attendance.monthConsole.bottom.issuesTitle")}
            density="compact"
            mobileLayout="compact"
            rows={[...shown]}
            rowId={item => item.key}
            selected={selectedKey}
            onSelect={key => {
              const found = byKey.get(key);
              if (found) onInspect(found);
            }}
            columns={[
              {
                header: t("attendance.col.date"),
                wide: true,
                fit: true,
                cell: item => <bdi className="num">{item.date.slice(5)}</bdi>,
              },
              {
                header: `${t("attendanceRecords.grid.name")} · ${t("attendanceRecords.grid.number")}`,
                card: "title",
                rowHeader: true,
                cell: item => {
                  const datePrefix = `${item.date.slice(5)} · `;
                  const personText = item.employeeNumber ? `${item.name} ${item.employeeNumber}` : item.name;
                  return (
                    <bdi>
                      <bdi className={s.phoneOnly}>{datePrefix}</bdi>
                      {personText}
                    </bdi>
                  );
                },
              },
              {
                header: t("attendance.col.kind"),
                card: "fact",
                cell: item => <bdi className={s.nowrap}>{t(`attendanceRecords.mark.${item.mark}`)}</bdi>,
              },
              {
                header: t("attendance.monthConsole.bottom.recognitionCol"),
                wide: true,
                cell: item => <bdi className="t-xs muted">{recognitionSummary(item)}</bdi>,
              },
              {
                header: t("attendance.col.state"),
                card: "status",
                fit: true,
                cell: item => statusChip(item),
              },
              {
                header: <bdi className="sr-only">{t("attendanceRecords.board.nextAction")}</bdi>,
                card: "action",
                fit: true,
                cell: item => (
                  <Button
                    size="sm"
                    variant="secondary"
                    className={s.nowrap}
                    onClick={e => {
                      e.stopPropagation();
                      onInspect(item);
                    }}
                  >
                    {t("attendance.monthConsole.bottom.checkAction")}
                  </Button>
                ),
              },
            ]}
          />
        )
      }
      basisTitle={t("attendance.monthConsole.bottom.basisTitle")}
      basisText={t("attendanceRecords.recognition.basis")}
      legendItems={[
        { key: "work", glyph: "·", text: t("attendance.dayKind.WORK") },
        { key: "rest", glyph: "—", text: t("attendance.dayKind.WEEKLY_HOLIDAY") },
        { key: "blocking", glyph: GLYPH.danger, text: t("attendance.monthConsole.legend.blocking") },
        { key: "decision", glyph: GLYPH.warn, text: t("attendance.monthConsole.legend.decision") },
        { key: "info", glyph: GLYPH.info, text: t("attendance.monthConsole.legend.info") },
        { key: "draft", glyph: "□", text: t("attendance.monthConsole.legend.draft") },
      ]}
    />
  );
}
