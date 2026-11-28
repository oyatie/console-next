// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { KeyValue } from "../../../ui/key-value/key-value";
import { PageHead } from "../../../ui/page-head/page-head";
import { FormPattern } from "../../../ui/patterns/form";
import { FormSection } from "../../../ui/patterns/form-section";
import {
  grantLocationConsent,
  locationConsentStatusQuery,
  resumeLocationConsent,
  suspendLocationConsent,
  withdrawLocationConsent,
  type LocationConsentState,
  type LocationConsentStatus,
} from "../api/location-consent";

const stateTone = (state: LocationConsentState) =>
  state === "GRANTED" ? "ok" : state === "SUSPENDED" ? "warn" : state === "WITHDRAWN" ? "danger" : "neutral";

export function LocationConsentPage() {
  const statusQ = useQuery(locationConsentStatusQuery);
  const current = statusQ.data;

  const transition = useCommand({
    run: (action: "grant" | "suspend" | "resume" | "withdraw") => {
      const branchId = current?.branch_id;
      if (action === "grant") return grantLocationConsent(branchId);
      if (action === "suspend") return suspendLocationConsent(branchId);
      if (action === "resume") return resumeLocationConsent(branchId);
      return withdrawLocationConsent(branchId);
    },
    invalidates: ["/api/v1/location-consent/status"],
    onSuccess: () => announce(t("account.location.done")),
  });

  const renderBody = (status: LocationConsentStatus) => {
    const latestAt = status.updated_at ?? status.withdrawn_at ?? status.resumed_at ?? status.suspended_at ?? status.granted_at;
    return (
      <>
        <FormSection>
          <h2>{t("account.location.summary")}</h2>
          <KeyValue
            label={t("account.location.summary")}
            items={[
              {
                key: "state",
                label: t("account.location.state"),
                value: <Chip tone={stateTone(status.state)}>{t(`account.location.state.${status.state}`)}</Chip>,
              },
              {
                key: "collection",
                label: t("account.location.collection"),
                value: status.may_collect ? t("account.location.collectionOn") : t("account.location.collectionOff"),
              },
              ...(latestAt
                ? [
                    {
                      key: "updatedAt",
                      label: t("account.location.updatedAt"),
                      value: <time dateTime={latestAt}>{fmtDateTime(latestAt)}</time>,
                    },
                  ]
                : []),
            ]}
          />
        </FormSection>
        <FormSection>
          <h2>{t("account.location.noticeTitle")}</h2>
          <p className="muted">{t("account.location.noticeBody")}</p>
        </FormSection>
        <CommandError error={transition.error} />
      </>
    );
  };

  const renderActions = (status: LocationConsentStatus | undefined) => (
    <>
      <Link to="/account" className={buttonClass("secondary")}>
        {t("common.back")}
      </Link>
      {(status?.state === "NO_RECORD" || status?.state === "WITHDRAWN") && (
        <Button variant="primary" disabled={transition.isPending} onClick={() => transition.mutate("grant")}>
          {t("account.location.grant")}
        </Button>
      )}
      {status?.state === "GRANTED" && (
        <Button variant="secondary" disabled={transition.isPending} onClick={() => transition.mutate("suspend")}>
          {t("account.location.suspend")}
        </Button>
      )}
      {status?.state === "SUSPENDED" && (
        <Button variant="primary" disabled={transition.isPending} onClick={() => transition.mutate("resume")}>
          {t("account.location.resume")}
        </Button>
      )}
      {(status?.state === "GRANTED" || status?.state === "SUSPENDED") && (
        <Button variant="danger" disabled={transition.isPending} onClick={() => transition.mutate("withdraw")}>
          {t("account.location.withdraw")}
        </Button>
      )}
    </>
  );

  return (
    <FormPattern
      q={statusQ}
      back={{ to: "/account", label: t("shell.profile") }}
      head={{ title: t("account.location.title"), titleId: "location-consent-title" }}
      sections={current ? renderBody(current) : null}
      actions={renderActions(current)}
      onSubmit={() => {}}
      baseline={() => (
        <main className="page" data-floorplan="P-04">
          <PageHead title={t("account.location.title")} />
          <QueryState q={statusQ} layout="form">
            {(data) => (
              <Card>
                <div className="form">
                  {renderBody(data)}
                  <div className="form__actions">{renderActions(data)}</div>
                </div>
              </Card>
            )}
          </QueryState>
        </main>
      )}
    />
  );
}
