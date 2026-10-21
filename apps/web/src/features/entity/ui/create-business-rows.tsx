import { Plus, X } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { TextInput } from "../../../ui/field/field";
import type { BusinessTypeDraft } from "../domain/draft";
import { RefPick } from "./ref-pick";
import s from "./entity-create.module.css";

/**
 * Item 7, kind of business: one row per sector and item as printed, the first one the main (main) row. The industry classification is picked
 * from the bundled list, never typed; while that list is not loaded the row says so and the code stays a to-do.
 */
export function BusinessRows({ rows, onChange }: { rows: BusinessTypeDraft[]; onChange: (rows: BusinessTypeDraft[]) => void }) {
  const setRow = (i: number, patch: Partial<BusinessTypeDraft>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className={s.rows} role="group" aria-label={t("entityCreate.business.label")}>
      <div className={s.rowsHead} aria-hidden>
        <span>{t("entityCreate.business.kind")}</span>
        <span>{t("entityCreate.business.sector")}</span>
        <span>{t("entityCreate.business.item")}</span>
        <span>{t("entityCreate.business.ksic")}</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div key={i} className={s.rowsLine}>
          <Chip tone="neutral">{t(i === 0 ? "entityCreate.business.main" : "entityCreate.business.sub")}</Chip>
          <TextInput aria-label={t("entityCreate.business.sectorOf", { n: i + 1 })} value={r.sector} onChange={(e) => setRow(i, { sector: e.target.value })} />
          <TextInput aria-label={t("entityCreate.business.itemOf", { n: i + 1 })} value={r.item} onChange={(e) => setRow(i, { item: e.target.value })} />
          <RefPick listKey="ksic" label={t("entityCreate.business.ksicOf", { n: i + 1 })} required={false} value={r.ksic} onChange={(ksic) => setRow(i, { ksic })} />
          {i > 0 ? (
            <Button variant="ghost" aria-label={t("entityCreate.business.remove", { n: i + 1 })} onClick={() => onChange(rows.filter((_, j) => j !== i))}><X size={16} aria-hidden /></Button>
          ) : <span />}
        </div>
      ))}
      <div className={s.rowsFoot}>
        <Button variant="ghost" onClick={() => onChange([...rows, { sector: "", item: "", ntsCode: null, ksic: null }])}>
          <Plus size={16} aria-hidden /> {t("entityCreate.business.add")}
        </Button>
      </div>
    </div>
  );
}
