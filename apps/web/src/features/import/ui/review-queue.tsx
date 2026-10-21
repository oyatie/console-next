import { useState } from "react";
import { t } from "@console/i18n";
import { ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import type { ImportDryRun, ReviewItem } from "../domain/contract";
import { filterQueue, heldAnswer, placeOf, type QueueFilter } from "../domain/review";
import { isValueItem } from "../domain/values";
import type { Picks } from "../domain/steps";
import { fieldLabel, reviewReasonLabel } from "../present";
import { ReviewResolve } from "./review-resolve";
import s from "./import.module.css";

/**
 * The needs-review queue the server counted: blocking items first, each with its reason, the cell it is at and the
 * text it is about. Choosing an item opens it below (the step opens the first blocking one), and answering it runs the
 * dry run again, after which the next item is open. Virtualised: a 3,000-row file can raise thousands.
 */
export function ReviewQueue({ dry, picks, busy, sel, onSel, onResolve, onSheets }: {
  dry: ImportDryRun;
  picks: Picks;
  busy: boolean;
  /** The open item (shared with the value-link tables: one answer is open at a time). */
  sel: string | null;
  onSel: (id: string) => void;
  onResolve: (c: Picks) => void;
  onSheets: () => void;
}) {
  // Value texts are answered in the value-link tables; the queue keeps people, rows, numbers and sheets.
  const rest = dry.review.items.filter((i) => !isValueItem(i));
  const q = { count: rest.length, blocking: rest.filter((i) => i.blocking).length };
  const [filter, setFilter] = useState<QueueFilter>(q.blocking > 0 ? "blocking" : "all");
  // Once nothing blocks, the blocking view would be empty: the whole queue shows instead.
  const items = filterQueue(rest, filter === "blocking" && q.blocking === 0 ? "all" : filter);
  const current = items.find((i) => i.id === sel);
  // The one count of the whole import's questions (values included), as every step heads it.
  const title = t("importReview.title", { count: dry.review.count });
  const columns: LongColumn<ReviewItem>[] = [
    { id: "reason", header: t("importReview.col.reason"), cell: (i) => <span className={s.cellLine}>{i.blocking && <Chip tone="danger">{t("importReview.blocking")}</Chip>} {reviewReasonLabel(i)}</span>, rowHeader: true, width: "3fr" },
    { id: "place", header: t("importReview.col.place"), cell: (i) => <span className="num">{t("importReview.place", placeOf(i))}</span>, width: 140 },
    { id: "value", header: t("importReview.col.value"), cell: (i) => i.value ?? (i.field ? fieldLabel(i.field) : "—"), width: "2fr" },
    { id: "rows", header: t("importReview.col.rows"), cell: (i) => <span className="num">{i.rows}</span>, width: 64 },
    { id: "state", header: t("importReview.col.state"), cell: (i) => (heldAnswer(picks, i) != null ? <Chip tone="info">{t("importReview.answered")}</Chip> : null), width: 120 },
  ];
  return (
    <section className="card" aria-labelledby="import-review">
      <div className="toolbar">
        <h2 id="import-review" className="toolbar__title" tabIndex={-1}>{title}</h2>
        {q.count > 0 && (
          <div className={s.filters} role="group" aria-label={title}>
            <ToggleButton pressed={filter === "blocking" && q.blocking > 0} onClick={() => setFilter("blocking")}>{t("importReview.filter.blocking", { count: q.blocking })}</ToggleButton>
            <ToggleButton pressed={filter === "all" || q.blocking === 0} onClick={() => setFilter("all")}>{t("importReview.filter.all", { count: q.count })}</ToggleButton>
          </div>
        )}
      </div>
      {dry.review.count === 0 ? (
        <p className={`muted ${s.inset}`}>{t("importReview.none")}</p>
      ) : q.count === 0 ? null : (
        <>
          <LongTable
            label={title}
            caption={t("importReview.caption", { shown: items.length, count: q.count })}
            columns={columns}
            rows={items}
            rowId={(i) => i.id}
            hasMore={false}
            onLoadMore={() => undefined}
            empty={t("importReview.emptyFilter")}
            density="compact"
            onRowAction={onSel}
          />
          {current && <ReviewResolve key={current.id} item={current} dry={dry} picks={picks} busy={busy} onResolve={onResolve} onSheets={onSheets} />}
        </>
      )}
    </section>
  );
}
