import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { PRIVACY_POLICY_URL } from "@console/api";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { KeyValue } from "../../../ui/key-value/key-value";
import { consentQuery } from "../api";

/** What I agreed to, read-only: there is no withdrawal endpoint. A failed read never blocks the page. */
export function ConsentCard() {
  const q = useQuery(consentQuery);
  const nav = useNavigate();
  return (
    <Card title={t("account.consent.title")}>
      {q.data ? (
        <>
          <KeyValue
            items={[{
              key: "privacy",
              label: t("account.consent.privacy", { version: q.data.policy_version }),
              value: q.data.accepted ? t("account.consent.accepted", { at: fmtDateTime(q.data.accepted_at) }) : t("account.consent.pending"),
            }]}
          />
          {!q.data.accepted && (
            <div className="row">
              <Button variant="secondary" onClick={() => void nav({ to: "/setup-passkey" })}>
                {t("auth.setup.title")}
              </Button>
            </div>
          )}
          <div className="muted">{PRIVACY_POLICY_URL}</div>
        </>
      ) : q.error ? (
        <div className="row" role="alert">
          <span className="muted">{t("account.consent.failed")}</span>
          <Button variant="ghost" onClick={() => void q.refetch()}>{t("common.retry")}</Button>
        </div>
      ) : (
        <span className="muted" role="status">{t("common.loading")}</span>
      )}
    </Card>
  );
}
