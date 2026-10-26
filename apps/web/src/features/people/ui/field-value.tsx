// SPDX-License-Identifier: LicenseRef-Proprietary
import { fmtDate } from "@console/i18n/format";
import { phoneDisplay } from "../../../lib/pure/formats";
import { revealField, type RevealField } from "../api/record";
import { fullAddress } from "../domain/card";
import { MaskedValue } from "./masked-value";

/** Only the response of the governed use case can supply the displayed value. */
export function FieldValue({ employeeId, fieldCode, allowed, ...props }: { employeeId: string; fieldCode: RevealField; allowed: boolean; masked: string; field: string; who: string }) {
  return <MaskedValue key={employeeId} {...props} reveal={allowed ? async (reason, note) => {
    const r = await revealField(employeeId, fieldCode, reason, note);
    const value = r.value;
    if (fieldCode === "ADDRESS") {
      if (typeof value === "string") throw new Error("invalid_reveal_value");
      return { value: fullAddress(value), displaySeconds: r.display_seconds };
    }
    if (typeof value !== "string") throw new Error("invalid_reveal_value");
    return { value: fieldCode === "BIRTH_DATE" ? fmtDate(value) : fieldCode === "PHONE" ? phoneDisplay(value) : value, displaySeconds: r.display_seconds };
  } : undefined} />;
}
