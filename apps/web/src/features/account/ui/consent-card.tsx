import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { KeyValue } from "../../../ui/key-value/key-value";
import { consentDocumentsQuery, consentQuery } from "../api";

/** What I agreed to, read-only: there is no withdrawal endpoint. A failed read never blocks the page. */
export function ConsentCard() {
  const q = useQuery(consentQuery);
  const documents = useQuery(consentDocumentsQuery);
  const nav = useNavigate();
  return (
    <Card title={t("account.consent.title")}>
      <QueryState q={q}>{d => (
        <>
          <KeyValue
            items={[{
              key: "privacy",
              label: t("account.consent.privacy", { version: d.policy_version }),
              value: d.accepted ? t("account.consent.accepted", { at: fmtDateTime(d.accepted_at) }) : t("account.consent.pending"),
            }]}
          />
          {!d.accepted && (
            <div className="row">
              <Button variant="secondary" onClick={() => void nav({ to: "/setup-passkey" })}>
                {t("auth.setup.title")}
              </Button>
            </div>
          )}
          {documents.data && <div className="muted">{t("auth.setup.consent.policy")}: {documents.data.privacy.policy_url}</div>}
        </>
      )}</QueryState>
    </Card>
  );
}
