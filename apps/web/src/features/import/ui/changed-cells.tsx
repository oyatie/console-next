import { t } from "@console/i18n";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { Card } from "../../../ui/card/card";
import type { ImportDryRun } from "../domain/contract";
import { changedCells, type ChangedCell } from "../domain/changes";
import { employmentTypeLabel, fieldLabel, routeLabel, shown } from "../present";
import s from "./import.module.css";

/**
 * People on file this file changes (spec E7-update): one row per changed cell — who, which field, what it is now and
 * what the file says — and how it is recorded: as a correction by this import, or by the other procedure that owns it
 * (a transfer, an exit) and is only named here. The counts head it: changed people, rows that stay as they are, and
 * the answers still to give.
 */
export function ChangedCells({ dry, consoleMode = false }: { dry: ImportDryRun; consoleMode?: boolean }) {
  const cells = changedCells(dry.rows);
  if (cells.length === 0) return null;
  const people = new Set(cells.map((c) => c.key)).size;
  const value = (c: ChangedCell, v?: string | null) => (c.field === "employment_type" && v ? employmentTypeLabel(v) : shown(v));
  const title = t("importChanges.title", { cells: cells.length, people });
  return (
    <Card
      titleId="import-changes"
      title={title}
      tools={
        <div className={s.filters}>
          <Chip tone="info">{t("importChanges.changed", { n: people })}</Chip>
          <Chip>{t("importChanges.same", { n: dry.unchanged_rows })}</Chip>
          <Chip tone={dry.review.blocking ? "warn" : "neutral"}>{t("importChanges.open", { n: dry.review.blocking })}</Chip>
        </div>
      }
    >
      <Table<ChangedCell>
        label={title}
        density={consoleMode ? "compact" : undefined}
        mobileLayout={consoleMode ? "compact" : "cards"}
        rows={cells}
        rowId={(c) => `${c.key}\u0000${c.field}`}
        columns={[
          { header: t("importChanges.col.number"), card: consoleMode ? "omit" : undefined, cell: (c) => <span className="code">{c.number ?? "—"}</span>, fit: true },
          {
            header: t("importChanges.col.name"),
            card: consoleMode ? "fact" : undefined,
            cell: (c) =>
              consoleMode ? (
                <>
                  {c.name}
                  {c.number ? <bdi className={s.phoneOnly}>{" · "}<code className="code">{c.number}</code></bdi> : null}
                </>
              ) : (
                c.name
              ),
            fit: true,
          },
          {
            header: t("importChanges.col.field"),
            card: consoleMode ? "title" : undefined,
            cell: (c) =>
              consoleMode ? (
                <>
                  <b className={s.desktopOnly}>{fieldLabel(c.field)}</b>
                  <bdi className={s.phoneOnly}>{t("import.rows.change", { field: fieldLabel(c.field), before: value(c, c.from), after: value(c, c.to) })}</bdi>
                </>
              ) : (
                <b>{fieldLabel(c.field)}</b>
              ),
            fit: true,
          },
          { header: t("importChanges.col.now"), card: consoleMode ? "omit" : undefined, cell: (c) => value(c, c.from) },
          { header: t("importChanges.col.file"), card: consoleMode ? "omit" : undefined, cell: (c) => <b>{value(c, c.to)}</b> },
          {
            header: t("importChanges.col.record"),
            card: consoleMode ? "status" : undefined,
            cell: (c) => (c.route ? <Chip tone="warn">{t("importChanges.route", { route: routeLabel(c.route) })}</Chip> : <Chip tone="info">{t("importChanges.correction")}</Chip>),
            fit: true,
          },
        ]}
      />
    </Card>
  );
}
