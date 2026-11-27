// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cancelledRecoveryNotice,
  dismissCancelledRecoveryNotice,
  generateRecoveryCodes,
  recoveryStatus,
  subscribeCancelledRecovery,
  upsertRecoveryContact,
  type RecoveryChannel,
} from "@console/api/recovery";
import { t } from "@console/i18n";
import { read } from "../lib/query";
import { announce } from "../lib/react/announce";
import { signInError } from "../lib/refusal";
import { Banner } from "../ui/banner/banner";
import { Button } from "../ui/button/button";
import { Card } from "../ui/card/card";
import { Checks } from "../ui/choice/checks";
import { ChoiceField } from "../ui/choice/choice-field";
import { Chip } from "../ui/chip";
import { Dialog } from "../ui/dialog";
import { Field, TextInput } from "../ui/field/field";

export function SetupPasskeyRecovery({
  busy,
  setBusy,
  onError,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onError: (msg: string | null) => void;
}) {
  const recoveryConsentDesc = useId();
  const [channel, setChannel] = useState<RecoveryChannel>("EMAIL");
  const [contactValue, setContactValue] = useState("");
  const [contactConsent, setContactConsent] = useState<string[]>([]);
  const [issuedCodes, setIssuedCodes] = useState<string[] | null>(null);
  const autoCancelled = useSyncExternalStore(subscribeCancelledRecovery, cancelledRecoveryNotice, () => false);
  const recStatus = useQuery({
    ...read("/api/v1/auth/recovery/status", recoveryStatus),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const eligible = Boolean(recStatus.data?.eligible);
  if (!eligible && !autoCancelled) return null;

  const saveRecoveryAndIssue = async () => {
    if (!contactValue.trim() || !contactConsent.includes("recovery") || busy) return;
    setBusy(true);
    onError(null);
    try {
      await upsertRecoveryContact({ channel, value: contactValue.trim(), consentAccepted: true });
      const batch = await generateRecoveryCodes();
      setIssuedCodes(batch.codes);
      await recStatus.refetch();
    } catch (e) {
      onError(signInError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {autoCancelled && (
        <Banner live="polite">
          {t("auth.recovery.autoCancelled")}
          <Button variant="ghost" size="sm" onClick={dismissCancelledRecoveryNotice}>{t("common.closePanel")}</Button>
        </Banner>
      )}
      {eligible && recStatus.data && (
        <Card title={t("auth.setup.recovery.title")}>
          <div className="form">
            {recStatus.data.contact && (
              <div className="row">
                <span>
                  {t("auth.setup.recovery.ready", {
                    masked: recStatus.data.contact.masked_value,
                    remaining: recStatus.data.codes.remaining,
                    total: recStatus.data.codes.total,
                  })}
                </span>
                {recStatus.data.contact.review_pending && <Chip>{t("auth.setup.recovery.reviewPending")}</Chip>}
              </div>
            )}
            <ChoiceField
              label={t("auth.setup.recovery.channel")}
              required={false}
              options={(["EMAIL", "PHONE"] as const).map((k) => ({ value: k, label: t(`auth.setup.recovery.channel.${k}`) }))}
              value={channel}
              onChange={(v) => setChannel((v as RecoveryChannel) ?? "EMAIL")}
            />
            <Field label={t("auth.setup.recovery.value")} required={false}>
              {(p) => (
                <TextInput
                  {...p}
                  readOnly={busy}
                  inputMode={channel === "EMAIL" ? "email" : "tel"}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={contactValue}
                  onChange={(e) => setContactValue(e.target.value)}
                />
              )}
            </Field>
            <Checks
              label={t("auth.setup.recovery.title")}
              items={[{ id: "recovery", label: t("auth.setup.recovery.consent"), description: recoveryConsentDesc }]}
              value={contactConsent}
              onChange={setContactConsent}
              isDisabled={busy}
            />
            <p className="muted auth__terms" id={recoveryConsentDesc}>{t("auth.setup.recovery.consentBody")}</p>
            <Button disabled={busy || !contactValue.trim() || !contactConsent.includes("recovery")} onClick={() => void saveRecoveryAndIssue()}>
              {t("auth.setup.recovery.saveAndIssue")}
            </Button>
          </div>
        </Card>
      )}
      {issuedCodes && (
        <Dialog open title={t("auth.setup.recovery.codesTitle")} onClose={() => setIssuedCodes(null)} dismissable={false}>
          <p className="muted">{t("auth.setup.recovery.codesOnce")}</p>
          <pre className="secret">{issuedCodes.join("\n")}</pre>
          <div className="form__actions">
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(issuedCodes.join("\n"))
                  .then(() => announce(t("auth.setup.recovery.copiedAll")), () => announce(t("common.copyFailed")))
              }
            >
              {t("auth.setup.recovery.copyAll")}
            </Button>
            <Button variant="primary" onClick={() => setIssuedCodes(null)}>
              {t("auth.setup.recovery.savedAck")}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
