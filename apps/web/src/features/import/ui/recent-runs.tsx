import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtZonedDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { runsQuery } from "../api";
import { STATUS_TONE, statusLabel } from "../present";

/** Recent applied imports, each opening its stored result on the import screen. */
export function RecentRuns() {
  // Re-read on open: a run applied or rolled back since the last visit must show its new state.
  const runs = useQuery({ ...runsQuery, refetchOnMount: "always" });
  return (
    <section className="card" aria-labelledby="import-runs">
      <div className="section-head"><h2 id="import-runs" className="toolbar__title">{t("import.runs.title")}</h2></div>
      <QueryState q={runs}>
        {(d) =>
          d.items.length === 0 ? (
            <p className="muted">{t("import.rows.none")}</p>
          ) : (
            <Table
              label={t("import.runs.title")}
              rows={d.items}
              rowId={(r) => r.id}
              columns={[
                { header: t("import.runs.col.file"), cell: (r) => <Link to="/people/import" search={{ run: r.id }}>{r.source_filename}</Link> },
                { header: t("import.runs.col.status"), cell: (r) => <Chip tone={STATUS_TONE[r.status]}>{statusLabel(r.status)}</Chip>, fit: true },
                { header: t("import.runs.col.applied"), cell: (r) => r.applied_at ? <time className="num" dateTime={r.applied_at}>{fmtZonedDateTime(r.applied_at)}</time> : "—", fit: true },
                { header: t("import.runs.col.counts"), cell: (r) => <span className="num">{r.apply_summary ? t("import.runs.counts", { inserted: r.apply_summary.inserted, updated: r.apply_summary.updated }) : "—"}</span>, fit: true, wide: true },
              ]}
            />
          )
        }
      </QueryState>
    </section>
  );
}
