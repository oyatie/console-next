// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { RrnValue } from "../../people/ui/rrn-value";
import { rrnQuery } from "../api";

export function RrnCard({ employeeId, who }: { employeeId: string; who: string }) {
  const status = useQuery(rrnQuery(employeeId));
  const value = status.data;
  return (
    <Card title={t("identifiers.rrn.title")} meta={value && (value.recorded && value.recorded_at ? t("identifiers.rrn.recorded", { at: fmtDateTime(value.recorded_at), source: t(`identifiers.rrn.source.${value.source ?? "IMPORT"}`) }) : t("identifiers.rrn.why"))}>
      <QueryState q={status}>{(s) => <>
        {s.recorded ? <RrnValue employeeId={employeeId} who={who} masked={s.masked ?? ""} /> : t("identifiers.rrn.none")}
      </>}</QueryState>
    </Card>
  );
}
