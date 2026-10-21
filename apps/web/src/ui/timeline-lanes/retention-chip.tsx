import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Chip } from "../chip";

export type Retention =
  | { state: "retained"; until: string }
  | { state: "due" | "destroyed" }
  | { state: "hold"; reason: string };

export function RetentionChip({ retention }: { retention: Retention }) {
  const { state } = retention;
  return <Chip tone={state === "due" ? "warn" : "neutral"}>
    {state === "retained" ? t("timeline.retained", { until: fmtDate(retention.until) })
      : state === "hold" ? t("timeline.hold", { reason: retention.reason })
        : t(`timeline.retention.${state}`)}
  </Chip>;
}
