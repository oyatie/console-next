// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { components } from "@console/api/schema";
import { Card } from "../../../ui/card/card";
import { RrnField } from "../../people/ui/rrn-field";
import { rrnQuery } from "../api";

export function RrnCard({ employeeId, employeeStatus, who }: { employeeId: string; employeeStatus: components["schemas"]["Employee"]["status"]; who: string }) {
  const status = useQuery(rrnQuery(employeeId));
  const value = status.data;
  return (
    <Card title={t("identifiers.rrn.title")} meta={value && (value.recorded && value.recorded_at ? t("identifiers.rrn.recorded", { at: fmtDateTime(value.recorded_at), source: t(`identifiers.rrn.source.${value.source ?? "IMPORT"}`) }) : t("identifiers.rrn.why"))}>
      <RrnField employeeId={employeeId} employeeStatus={employeeStatus} who={who} q={status} />
    </Card>
  );
}
