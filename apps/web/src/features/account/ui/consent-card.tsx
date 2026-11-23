import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { KeyValue } from "../../../ui/key-value/key-value";
import { ExperienceSwitch } from "../../../ui/patterns/experience-switch";
import s from "./account.module.css";
import { consentDocumentsQuery, consentQuery } from "../api";

/** The status and notice settle independently, each in its own row. */
export function ConsentBody() {
  const q = useQuery(consentQuery);
  const documents = useQuery(consentDocumentsQuery);
  const notice = documents.data?.privacy;
  const baselineLabel = notice?.title ?? t("account.consent.privacy");
  const consoleLabel = !notice?.title || notice.title === "Privacy notice" ? t("account.consent.privacy") : notice.title;
  const label = <ExperienceSwitch baseline={() => baselineLabel}>{() => consoleLabel}</ExperienceSwitch>;
  const status = <QueryState q={q} loading={t("common.loading")}>{d => d.accepted
    ? t("account.consent.accepted", { at: fmtDateTime(d.accepted_at) })
    : <>{t("account.consent.pending")} · <Link to="/setup-passkey">{t("auth.setup.title")}</Link></>
  }</QueryState>;
  return (
    <>
      <KeyValue items={[{ key: "privacy", label, value: q.isLoadingError
        ? <details><summary className="t-xs">{t("common.loadFailed.title")}</summary>{status}</details>
        : status }]} />
      <details>
        <summary>{label}{notice?.published_on ? t("account.consent.edition", { date: fmtDate(notice.published_on) }) : ""} · {t("auth.setup.consent.disclosure")}</summary>
        <QueryState q={documents}>{d => <>
          <p className={s.notice}>{d.privacy.body}</p>
          <div className="muted">{t("auth.setup.consent.policy")}: {d.privacy.policy_url}</div>
        </>}</QueryState>
      </details>
    </>
  );
}

/** Baseline card wrapper for consent status and privacy notice disclosure. */
export function ConsentCard() {
  return (
    <Card title={t("account.consent.title")}>
      <ConsentBody />
    </Card>
  );
}
