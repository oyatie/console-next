// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import type { UseQueryResult } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { ReadReference } from "../../../lib/react/read-reference";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import type { MeProfile } from "../api";
import { formatRevealedValue, openRequestForField } from "../domain/profile";
import { AddressChangeButton } from "./me-address-sheet";
import { BankAccountAttestationButton } from "./me-bank-sheet";
import { EmergencyContactsButton } from "./me-emergency-sheet";
import { PhoneEditButton } from "./me-phone-sheet";
import { SelfRevealControls, SelfRevealError } from "./me-self-reveal";
import { useSelfReveal } from "./use-self-reveal";
import s from "./account.module.css";

export function SelfEditableBody({
  employeeId,
  profileQuery,
}: {
  employeeId: string;
  profileQuery: UseQueryResult<MeProfile>;
}) {
  const relationLabel = (rel: string) => t(`empCard.relation.${rel}` as Parameters<typeof t>[0]);
  const phoneReveal = useSelfReveal({
    employeeId,
    field: "PHONE",
    fieldLabel: t("account.selfEdit.phone"),
  });
  const emergencyReveal = useSelfReveal({
    employeeId,
    field: "EMERGENCY_CONTACTS",
    fieldLabel: t("account.selfEdit.emergency"),
  });
  const addressReveal = useSelfReveal({
    employeeId,
    field: "ADDRESS",
    fieldLabel: t("account.selfEdit.address"),
  });

  return (
    <QueryState
      q={profileQuery}
      compact
      denied={
        <EmptyState
          compact
          title={t("account.selfEdit.refused.title")}
          reason={t("account.selfEdit.refused")}
          meta={<ReadReference error={profileQuery.error} />}
        />
      }
    >
      {(profile) => {
        const openAddress = openRequestForField(profile.open_change_requests, "address");
        const openBank = openRequestForField(profile.open_change_requests, "bank_account_registered");
        return (
          <ul className="list-divided list-divided--rows" aria-label={t("account.selfEdit.title")}>
            <li className={s.editRow}>
              <div className={s.editRowBody}>
                <div className={s.fieldChips}>
                  <strong className="t-strong">{t("account.selfEdit.phone")}</strong>
                  <Chip tone="outline" className={s.actionBtn}>
                    {t("account.selfEdit.policy.instant")}
                  </Chip>
                </div>
                {phoneReveal.isRevealed ? (
                  <code className="num">
                    {formatRevealedValue("PHONE", phoneReveal.revealedValue, relationLabel)}
                  </code>
                ) : (
                  <div className={profile.phone_masked ? "num" : "muted"}>
                    {profile.phone_masked ?? t("person.field.notSet")}
                  </div>
                )}
                <SelfRevealError error={phoneReveal.error} />
              </div>
              <div className={s.editRowActions}>
                <SelfRevealControls
                  scope={phoneReveal.scope}
                  fieldLabel={t("account.selfEdit.phone")}
                  hasValue={Boolean(profile.phone_masked)}
                  isRevealed={phoneReveal.isRevealed}
                  seconds={phoneReveal.seconds}
                  isPending={phoneReveal.isPending}
                  onTrigger={phoneReveal.trigger}
                  onHide={phoneReveal.hide}
                  onKeyDown={phoneReveal.onKeyDown}
                />
                <PhoneEditButton currentMasked={profile.phone_masked ?? null} />
              </div>
            </li>

            <li className={s.editRow}>
              <div className={s.editRowBody}>
                <div className={s.fieldChips}>
                  <strong className="t-strong">{t("account.selfEdit.emergency")}</strong>
                  <Chip tone="outline" className={s.actionBtn}>
                    {t("account.selfEdit.policy.instant")}
                  </Chip>
                </div>
                {emergencyReveal.isRevealed ? (
                  <div className="t-sm">
                    {formatRevealedValue("EMERGENCY_CONTACTS", emergencyReveal.revealedValue, relationLabel)}
                  </div>
                ) : (
                  <div className={profile.emergency_contacts_registered ? "t-strong" : "muted"}>
                    {profile.emergency_contacts_registered
                      ? t("account.selfEdit.registered")
                      : t("account.selfEdit.unregistered")}
                  </div>
                )}
                <SelfRevealError error={emergencyReveal.error} />
              </div>
              <div className={s.editRowActions}>
                <SelfRevealControls
                  scope={emergencyReveal.scope}
                  fieldLabel={t("account.selfEdit.emergency")}
                  hasValue={profile.emergency_contacts_registered}
                  isRevealed={emergencyReveal.isRevealed}
                  seconds={emergencyReveal.seconds}
                  isPending={emergencyReveal.isPending}
                  onTrigger={emergencyReveal.trigger}
                  onHide={emergencyReveal.hide}
                  onKeyDown={emergencyReveal.onKeyDown}
                />
                <EmergencyContactsButton
                  employeeId={employeeId}
                  existing={profile.emergency_contacts}
                />
              </div>
            </li>

            <li className={s.editRow}>
              <div className={s.editRowBody}>
                <div className={s.fieldChips}>
                  <strong className="t-strong">{t("account.selfEdit.address")}</strong>
                  <Chip tone="outline" className={s.actionBtn}>
                    {t("account.selfEdit.policy.approval")}
                  </Chip>
                </div>
                {addressReveal.isRevealed ? (
                  <div className="t-sm">
                    {formatRevealedValue("ADDRESS", addressReveal.revealedValue, relationLabel)}
                  </div>
                ) : (
                  <div className={profile.address_masked ? "" : "muted"}>
                    {profile.address_masked ?? t("account.selfEdit.unregistered")}
                  </div>
                )}
                {openAddress && (
                  <div className={s.fieldChips}>
                    <Chip tone="warn" className={s.actionBtn}>
                      <Clock size={12} aria-hidden="true" /> {t("account.selfEdit.correctionPending")}
                    </Chip>
                  </div>
                )}
                <SelfRevealError error={addressReveal.error} />
              </div>
              <div className={s.editRowActions}>
                <SelfRevealControls
                  scope={addressReveal.scope}
                  fieldLabel={t("account.selfEdit.address")}
                  hasValue={Boolean(profile.address_masked)}
                  isRevealed={addressReveal.isRevealed}
                  seconds={addressReveal.seconds}
                  isPending={addressReveal.isPending}
                  onTrigger={addressReveal.trigger}
                  onHide={addressReveal.hide}
                  onKeyDown={addressReveal.onKeyDown}
                />
                {openAddress ? (
                  <Link
                    to="/people/requests"
                    search={{ lane: "filed", status: "OPEN", sel: openAddress.id }}
                    className={buttonClass("secondary", { size: "sm", className: s.actionBtn })}
                  >
                    {t("account.selfEdit.viewProgress")}
                  </Link>
                ) : (
                  <AddressChangeButton />
                )}
              </div>
            </li>

            <li className={s.editRow}>
              <div className={s.editRowBody}>
                <div className={s.fieldChips}>
                  <strong className="t-strong">{t("account.selfEdit.bankAccount")}</strong>
                  <Chip tone="outline" className={s.actionBtn}>
                    {t("account.selfEdit.policy.approval")}
                  </Chip>
                </div>
                <div className={profile.bank_account_registered ? "t-strong" : "muted"}>
                  {profile.bank_account_registered
                    ? t("account.selfEdit.registered")
                    : t("account.selfEdit.unregistered")}
                </div>
                {openBank && (
                  <div className={s.fieldChips}>
                    <Chip tone="warn" className={s.actionBtn}>
                      <Clock size={12} aria-hidden="true" /> {t("account.selfEdit.correctionPending")}
                    </Chip>
                  </div>
                )}
              </div>
              <div className={s.editRowActions}>
                {openBank ? (
                  <Link
                    to="/people/requests"
                    search={{ lane: "filed", status: "OPEN", sel: openBank.id }}
                    className={buttonClass("secondary", { size: "sm", className: s.actionBtn })}
                  >
                    {t("account.selfEdit.viewProgress")}
                  </Link>
                ) : (
                  <BankAccountAttestationButton currentRegistered={profile.bank_account_registered} />
                )}
              </div>
            </li>
          </ul>
        );
      }}
    </QueryState>
  );
}
