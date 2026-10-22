import { LEAVE_TYPE } from "../../../lib/labels";
import { EnumCode } from "../../../ui/enum-value";
import { t } from "@console/i18n";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import type { ImportDryRun, ReviewItem } from "../domain/contract";
import { heldAnswer, placeOf, resolveKind, rowOf } from "../domain/review";
import { withChoice, type Picks } from "../domain/steps";
import { choiceLabel, fieldLabel, reviewReasonLabel, routeLabel } from "../present";
import { ExcludeRow, Identity, NumberAnswer, ValuePick } from "./resolve-controls";
import s from "./import.module.css";

/**
 * One needs-review item, opened: what it is and where, then the one control that answers it. A served choice is one
 * click (the dry run runs again at once); a person, a unit or a employee number is picked or typed; a refused row is fixed in the
 * file or left out with a reason; a sheet goes back to its column mapping; an item with nothing to answer says what
 * happens to it.
 */
export function ReviewResolve({ item, dry, picks, busy, onResolve, onSheets }: {
  item: ReviewItem;
  dry: ImportDryRun;
  picks: Picks;
  busy: boolean;
  onResolve: (c: Picks) => void;
  onSheets: () => void;
}) {
  const kind = resolveKind(item);
  const res = item.resolution;
  const row = rowOf(dry, item);
  const held = heldAnswer(picks, item);
  const where = t("importReview.place", placeOf(item));
  return (
    <section className={`${s.resolve} ${s.resolveCard}`} aria-labelledby="import-resolve" aria-busy={busy || undefined}>
      <div className="toolbar">
        <h3 id="import-resolve" className="toolbar__title" tabIndex={-1}>{reviewReasonLabel(item)}</h3>
        {item.blocking ? <Chip tone="danger">{t("importReview.blocking")}</Chip> : <Chip tone="neutral">{t("importReview.notBlocking")}</Chip>}
      </div>
      <p className="muted">
        {item.reason === "remembered" ? t("importReview.remembered.why") : item.reason === "auto_mapped" ? t("importReview.autoWhy") : where}
        {item.value != null && <> · {t("importReview.valueOf", { field: item.source_column ?? (item.field ? fieldLabel(item.field) : ""), value: item.value })}</>}
        {row && <> · {row.name}</>}
        {item.rows > 1 && <> · {t("importReview.rows", { count: item.rows })}</>}
      </p>
      {kind === "choices" && res && (
        <div className={s.choices} role="group" aria-label={t("importReview.choose", { value: item.value ?? "" })}>
          {res.choices.map((c) => (
            <ToggleButton key={c} pressed={held === c} disabled={busy} onClick={() => onResolve(withChoice(picks, res.decision as "status_map", res.key, c))}>
              {choiceLabel(res.decision, c)} {res.decision === "leave_type_map" && <EnumCode e={LEAVE_TYPE} value={c} />}
            </ToggleButton>
          ))}
        </div>
      )}
      {kind === "identity" && res && row && <Identity item={item} row={row} picks={picks} busy={busy} onResolve={onResolve} />}
      {kind === "exclude" && res && row && <ExcludeRow item={item} row={row} picks={picks} busy={busy} onResolve={onResolve} />}
      {(kind === "company" || kind === "unit" || kind === "workplace" || kind === "type") && res && (
        <ValuePick kind={kind} text={res.key} item={item} picks={picks} busy={busy} onResolve={onResolve} />
      )}
      {kind === "number" && res && row && <NumberAnswer sourceKey={res.key} name={row.name} picks={picks} busy={busy} onResolve={onResolve} />}
      {kind === "mapping" && (
        <>
          <Button variant="primary" onClick={onSheets}>{t("importReview.toSheets")}</Button>
        </>
      )}
      {kind === "info" && <p>{info(item, row?.deferred?.find((d) => d.field === item.field)?.route)}</p>}
    </section>
  );
}

/** What happens to an item with nothing to answer: a difference another flow makes, an RRN that is set aside. */
function info(item: ReviewItem, route?: string) {
  if (item.reason === "deferred_change" && route) return t("importReview.info.deferred", { route: routeLabel(route as Parameters<typeof routeLabel>[0]) });
  return t(item.reason === "rrn_unavailable" || item.reason === "rrn_invalid" ? `importReview.info.${item.reason}` : "importReview.info.other");
}
