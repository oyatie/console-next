// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { revealRrn } from "../api/record";
import { MaskedValue } from "./masked-value";

/** The RRN adapter; the shared component owns purpose, refusal and display lifetime. */
export function RrnValue({ employeeId, who, masked }: { employeeId: string; who: string; masked: string }) {
  return <MaskedValue key={employeeId} masked={masked} field={t("empCard.f.rrn")} who={who} reveal={async (reason, note) => {
    const r = await revealRrn(employeeId, reason, note);
    return { value: r.rrn, displaySeconds: r.display_seconds ?? 0 };
  }} />;
}
