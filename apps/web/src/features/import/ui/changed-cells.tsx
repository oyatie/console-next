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
export function ChangedCells({ dry }: { dry: ImportDryRun }) {
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
        rows={cells}
        rowId={(c) => `${c.key}\u0000${c.field}`}
        columns={[
          { header: t("importChanges.col.number"), cell: (c) => <span className="code">{c.number ?? "—"}</span>, fit: true },
          { header: t("importChanges.col.name"), cell: (c) => c.name, fit: true },
          { header: t("importChanges.col.field"), cell: (c) => <b>{fieldLabel(c.field)}</b>, fit: true },
          { header: t("importChanges.col.now"), cell: (c) => value(c, c.from) },
          { header: t("importChanges.col.file"), cell: (c) => <b>{value(c, c.to)}</b> },
          { header: t("importChanges.col.record"), cell: (c) => (c.route ? <Chip tone="warn">{t("importChanges.route", { route: routeLabel(c.route) })}</Chip> : <Chip tone="info">{t("importChanges.correction")}</Chip>), fit: true },
        ]}
      />
    </Card>
  );
}
