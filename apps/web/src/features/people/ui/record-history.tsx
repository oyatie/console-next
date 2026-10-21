import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { RecordRows } from "../../../ui/record/rows";
import { Sheet } from "../../../ui/sheet/sheet";
import { recordHistoryQuery, type RecordEntry } from "../api/record";
import { ROW_SPEC, segmentOf } from "../domain/record-spec";
import { tx } from "../present";
import { Who } from "./card-who";
import type { Card } from "./use-card";

/** One entry's every version, newest first (GET …/history): what it said, why it changed, whether it was imported. */
export function RecordHistory({ c, entry, name, onClose }: { c: Card; entry: RecordEntry; name: string; onClose: () => void }) {
  const sec = segmentOf(entry.section);
  const q = useQuery(recordHistoryQuery(c.e.id, sec, entry.id));
  const spec = ROW_SPEC[sec] ?? [];
  const value = (fields: unknown) => {
    const f = (fields ?? {}) as Record<string, unknown>;
    return spec
      .filter((x) => f[x.key] != null && f[x.key] !== "")
      .map((x) => (x.kind === "choice" ? tx(`empRec.${sec}.${x.key}.${String(f[x.key])}`) : String(f[x.key])))
      .join(" · ");
  };
  return (
    <Sheet open kicker={<Who c={c} />} title={t("empRec.history.title", { name })} onClose={onClose} consequence={t("empRec.history.rule")} actions={<Button onClick={onClose}>{t("empRec.close")}</Button>}>
      <QueryState q={q}>
        {(h) => (
          <RecordRows
            label={t("empRec.history.title", { name })}
            rows={[...h.revisions].reverse()}
            rowId={(r) => String(r.version)}
            columns={[
              { header: t("empRec.history.when"), cell: (r) => fmtDateTime(r.created_at) },
              { header: t("empRec.history.kind"), cell: (r) => t(`empRec.history.kind.${r.kind}`) + (r.source === "IMPORT" ? ` · ${t("empRec.history.imported")}` : "") },
              { header: t("empRec.history.value"), cell: (r) => value(r.fields) || "—" },
              { header: t("empRec.history.why"), cell: (r) => r.reason || "—" },
            ]}
          />
        )}
      </QueryState>
    </Sheet>
  );
}
