import type { RegularWorkers } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { Chip } from "../../../ui/chip";
import { DerivedValue } from "../../../ui/field/derived-value";

/**
 * The regular headcount of an entity or a workplace (design §6; Labor Standards Act Enforcement Decree s7-2): derived
 * by the server, never typed. While the method is held for a labor attorney (BW-35) the server sends no value, so the
 * field says it is held, what it still needs, and the live roster count beside it, never as the headcount itself.
 */
export function RegularHeadcount({ r, asOf }: { r: RegularWorkers; asOf?: string }) {
  return (
    <DerivedValue
      label={t("capture.headcount.label")}
      value={
        <span className="row">
          <span>{r.value == null ? t("capture.headcount.held") : t("capture.headcount.value", { count: r.value })}</span>
          {r.status === "HOLD" && <Chip tone="warn">{t("capture.headcount.hold")}</Chip>}
        </span>
      }
      basis={
        <>
          {t("capture.headcount.live", { count: r.live_headcount, date: fmtDate(asOf ?? todayKst()) })}
          {r.missing.length > 0 && <> · {t("capture.headcount.missing")} {r.missing.map((m) => t(`capture.headcount.missing.${m}`)).join(", ")}</>}
        </>
      }
    />
  );
}
