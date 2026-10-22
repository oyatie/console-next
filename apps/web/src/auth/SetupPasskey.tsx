// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, LogOut } from "lucide-react";
import { acceptConsent, consentDocuments, consentStatus, logout, PASSKEY_ENROLLED, registerPasskey, session } from "@console/api";
import { t } from "@console/i18n";
import { read } from "../lib/query";
import { signInError } from "../lib/refusal";
import { Banner } from "../ui/banner/banner";
import { Button } from "../ui/button/button";
import { Card } from "../ui/card/card";
import { Checks } from "../ui/choice/checks";
import { PageHead } from "../ui/page-head/page-head";
import { Skeleton } from "../ui/skeleton/skeleton";
import { rememberDomain } from "./sign-in-id";

export function SetupPasskey() {
  const nav = useNavigate();
  const privacyDescription = useId();
  const termsDescription = useId();
  const disabledDescription = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signoffs, setSignoffs] = useState<string[]>([]);
  const documents = useQuery({ ...read("/api/v1/onboarding/terms", consentDocuments), retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const status = useQuery({ ...read("/api/v1/auth/privacy-consent/status", consentStatus), retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const failed = documents.isError || status.isError;
  const loading = documents.isPending || status.isPending || documents.isFetching || status.isFetching;
  const ready = documents.data && status.data && !failed && !loading;
  const accepted = status.data?.accepted;
  const confirmed = accepted || (signoffs.includes("privacy") && signoffs.includes("terms"));
  const isAppSession = session.stage === "app";

  const enroll = async () => {
    if (!ready || !confirmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!accepted) await acceptConsent(documents.data);
      if (!isAppSession) {
        const signInId = await registerPasskey();
        if (signInId) rememberDomain(signInId.split("@")[1]!);
      }
      await nav({ to: session.claims?.platform ? "/platform" : "/" });
    } catch (e) {
      // Registration succeeded; a failed automatic sign-in continues on the login screen.
      if (e instanceof Error && e.message === PASSKEY_ENROLLED) return void (await nav({ to: "/login", search: { enrolled: true } }));
      setError(signInError(e));
    } finally {
      setBusy(false);
    }
  };
  const retry = () => {
    setSignoffs([]);
    void documents.refetch();
    void status.refetch();
  };

  return (
    <main className="auth">
      <div className="auth__frame"><Card flush><div className="auth__content">
        <PageHead title={t(isAppSession ? "auth.setup.consent.title" : "auth.setup.title")} />
        {error && <Banner tone="danger" live="assertive">{error}</Banner>}
        {loading && <Skeleton bones={["row", "row"]} label={t("common.loading")} />}
        {failed && <Banner tone="danger" live="assertive">
          {t("auth.setup.consent.loadFailed")}
          <Button disabled={busy || loading} onClick={retry}>{t("common.retry")}</Button>
        </Banner>}
        <div className="form">
          <Checks
            label={t("auth.setup.consent.title")}
            items={[
              { id: "privacy", label: t("auth.setup.consent.privacy"), description: privacyDescription },
              { id: "terms", label: t("auth.setup.consent.terms"), description: termsDescription },
            ]}
            value={accepted ? ["privacy", "terms"] : signoffs}
            onChange={setSignoffs}
            isDisabled={busy || !ready}
          />
          {documents.data && <>
            <details className="muted" id={privacyDescription}>
              <summary>{t("auth.setup.consent.privacy")} · {t("auth.setup.consent.disclosure")}{documents.data.privacy.review_pending && <> ({t("auth.setup.consent.reviewPending")})</>}</summary>
              <p className="auth__terms">{documents.data.privacy.body}</p>
            </details>
            <details className="muted" id={termsDescription}>
              <summary>{t("auth.setup.consent.terms")} · {t("auth.setup.consent.disclosure")}</summary>
              <p className="auth__terms">{documents.data.body}</p>
            </details>
            <p className="muted">{t("auth.setup.consent.policy")}: <span>{documents.data.privacy.policy_url}</span></p>
          </>}
        </div>
        <Button variant="primary" disabled={busy || !ready || !confirmed} aria-describedby={!confirmed ? disabledDescription : undefined} onClick={enroll}>
          {!isAppSession && <KeyRound size={16} aria-hidden />} {t(isAppSession ? "auth.setup.consent.continue" : "auth.setup.register")}
        </Button>
        {!confirmed && <p className="muted" id={disabledDescription}>{t("auth.setup.consent.required")}</p>}
        <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
          <LogOut size={16} aria-hidden /> {t(isAppSession ? "shell.logout" : "auth.setup.cancel")}
        </Button>
      </div></Card></div>
    </main>
  );
}
