// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { SupportLookupForm } from "../../../lib/react/support-lookup";
import { Button } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import type { Issued, Org, Recorded } from "../api";
import { CodeDialog } from "./code-dialog";
import { OnboardDialog } from "./onboard-form";

export type IssuedTenantCode = Issued & { onboarded?: { id: string; slug: string } };

export function TenantConsoleOverlays({
  onboarding,
  lookupOpen,
  issued,
  existing,
  onCloseOnboarding,
  onCloseLookup,
  onIssued,
  onSelectOrg,
  onRecorded,
}: {
  onboarding: boolean;
  lookupOpen: boolean;
  issued: IssuedTenantCode | null;
  existing: readonly Org[];
  onCloseOnboarding: () => void;
  onCloseLookup: () => void;
  onIssued: (code: IssuedTenantCode | null) => void;
  onSelectOrg: (id: string) => void;
  onRecorded: (r: Recorded) => void;
}) {
  const finishCode = () => {
    if (!issued) return;
    const { org, onboarded, expiresAt } = issued;
    onIssued(null);
    if (onboarded) onSelectOrg(onboarded.id);
    onRecorded(
      onboarded
        ? { message: t("tenants.onboard.done", { org }), meta: t("tenants.onboard.meta", { slug: onboarded.slug }) }
        : { message: t("tenants.reissue.done", { org }), meta: t("common.expiresAt", { at: fmtDateTime(expiresAt) }) },
    );
  };

  return (
    <>
      <OnboardDialog
        open={onboarding}
        existing={existing}
        onClose={onCloseOnboarding}
        onIssued={(result) => {
          onCloseOnboarding();
          onIssued(result);
        }}
        onLost={(org) => {
          onCloseOnboarding();
          onSelectOrg(org.id);
          onRecorded({
            message: t("tenants.form.lost", { org: org.name }),
            meta: t("tenants.onboard.meta", { slug: org.slug }),
          });
        }}
      />
      <CodeDialog issued={issued} onClose={finishCode} />
      <Dialog open={lookupOpen} title={t("tenants.supportLookup.title")} onClose={onCloseLookup}>
        <SupportLookupForm />
        <div className="form__actions">
          <Button onClick={onCloseLookup}>{t("tenants.code.close")}</Button>
        </div>
      </Dialog>
    </>
  );
}
