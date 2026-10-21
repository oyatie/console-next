import type { BusinessRegistration, LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { readVersion, reviseRegistration, reviseWorkplace } from "../api";
import { registrationInput, workplaceInput, workplaceName } from "../domain/view";
import { statusChange } from "../domain/workplace-change";
import { SuspendSheet } from "./suspend-sheet";

/** suspension / resumption of a workplace (company-06): a full-state revision with its status from the chosen day. */
export function WorkplaceStatusSheet({ e, w, onClose }: { e: LegalEntity; w: Workplace; onClose: () => void }) {
  const base = workplaceInput(e, w);
  const suspended = w.current?.status === "SUSPENDED";
  return (
    <SuspendSheet
      name={workplaceName(w)}
      suspended={suspended}
      since={suspended ? w.current?.status_since : null}
      people={w.headcount}
      onClose={onClose}
      save={(d, key) => {
        if (!base) throw new Error(t("entityOps.status.restricted"));
        return reviseWorkplace(key, w.id, { ...statusChange(base, d, !suspended), expected_version: readVersion(w) });
      }}
    />
  );
}

/** suspension / resumption of a business registration (company-06): the certificate as it stands, its status from the chosen day. */
export function RegistrationStatusSheet({ e, r, onClose }: { e: LegalEntity; r: BusinessRegistration; onClose: () => void }) {
  const base = registrationInput(e, r.id);
  const suspended = r.current?.status === "SUSPENDED";
  return (
    <SuspendSheet
      name={t("entityOps.status.certName", { brn: r.brn?.display ?? r.current?.trade_name ?? "" })}
      suspended={suspended}
      since={suspended ? r.current?.status_since : null}
      onClose={onClose}
      save={(d, key) => {
        if (!base) throw new Error(t("entityOps.status.restricted"));
        const status = suspended
          ? { status: "CONTINUING" as const, status_since: null, status_until: null, reason_code: "RESUMPTION" }
          : { status: "SUSPENDED" as const, status_since: d.since, status_until: d.until || null, reason_code: `SUSPENSION_${d.reason}` };
        return reviseRegistration(key, r.id, { ...base, ...status, effective_from: d.since, expected_version: readVersion(r) });
      }}
    />
  );
}
