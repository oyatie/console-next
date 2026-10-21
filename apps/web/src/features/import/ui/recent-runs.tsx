import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { runsQuery } from "../api";
import { STATUS_TONE, statusLabel } from "../present";

/** NOT MOUNTED (domain/pending, backend-followups #21 (a)). The tenant's recent applied imports, each opening its record (where a rollback is asked for and decided). */
export function RecentRuns() {
  // Re-read on open: a run applied or rolled back since the last visit must show its new state.
  const runs = useQuery({ ...runsQuery, refetchOnMount: "always" });
  return (
    <section className="card" aria-labelledby="import-runs">
      <div className="section-head"><h2 id="import-runs" className="toolbar__title">{t("import.runs.title")}</h2></div>
      <QueryState q={runs}>
        {(d) =>
          d.items.length === 0 ? (
            <p className="muted">{t("import.runs.empty")}</p>
          ) : (
            <Table
              label={t("import.runs.title")}
              rows={d.items}
              rowId={(r) => r.id}
              columns={[
                { header: t("import.runs.col.file"), cell: (r) => r.source_filename },
                { header: t("import.runs.col.status"), cell: (r) => <Chip tone={STATUS_TONE[r.status]}>{statusLabel(r.status)}</Chip>, fit: true },
                { header: t("import.runs.col.applied"), cell: (r) => <span className="num">{r.applied_at ? fmtDateTimeShort(r.applied_at) : "—"}</span>, fit: true },
                { header: t("import.runs.col.counts"), cell: (r) => <span className="num">{t("import.runs.counts", { inserted: r.inserted, updated: r.updated })}</span>, fit: true, wide: true },
              ]}
            />
          )
        }
      </QueryState>
    </section>
  );
}
