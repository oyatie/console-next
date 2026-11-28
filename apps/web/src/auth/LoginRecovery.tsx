// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { redeemRecoveryCode, startRecoveryChallenge } from "@console/api/recovery";
import { t } from "@console/i18n";
import { tr } from "@console/i18n/auth-recovery";
import { signInError } from "../lib/refusal";
import { Banner } from "../ui/banner/banner";
import { Button, Form } from "../ui/button/button";
import { Field, TextInput } from "../ui/field/field";
import { rememberedDomains } from "./sign-in-id";
import { parseSignInId } from "./sign-in-id-input";

export function RecoveryLoginBody({
  defaultId,
  busy,
  setBusy,
  abortAutofill,
  onError,
  normalizeCode,
  runRedeem,
}: {
  defaultId: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  abortAutofill: () => void;
  onError: (msg: string | null) => void;
  normalizeCode: (text: string) => string;
  runRedeem: (fn: () => Promise<void>) => void;
}) {
  const [recoveryId, setRecoveryId] = useState("");
  const [recoveryIdErr, setRecoveryIdErr] = useState<string | null>(null);
  const [challengeSent, setChallengeSent] = useState(false);
  const [savedRecoveryCode, setSavedRecoveryCode] = useState("");
  const [contactCode, setContactCode] = useState("");

  const sendChallenge = async () => {
    const candidate = recoveryId.trim() || defaultId.trim();
    const parsed = parseSignInId(candidate, rememberedDomains());
    if (parsed.kind !== "ok") {
      setRecoveryIdErr(
        parsed.kind === "invalid"
          ? t(parsed.nonAscii ? "auth.login.id.nonAscii" : "auth.login.id.invalid")
          : t("auth.login.id.needDomain"),
      );
      return;
    }
    abortAutofill();
    setBusy(true);
    onError(null);
    setRecoveryIdErr(null);
    try {
      await startRecoveryChallenge(parsed.id);
      setRecoveryId(parsed.id);
      setChallengeSent(true);
    } catch (e) {
      onError(signInError(e));
    } finally {
      setBusy(false);
    }
  };

  const submitRecovery = () => {
    if (!savedRecoveryCode.trim() || !contactCode.trim()) return;
    runRedeem(() => redeemRecoveryCode(savedRecoveryCode.trim(), contactCode.trim()));
  };

  return (
    <div className="form">
      <Field label={t("auth.login.id")} required={null} hint={t("auth.login.idHint")} error={recoveryIdErr ?? undefined}>
        {(p) => (
          <TextInput
            {...p}
            readOnly={busy}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="email"
            value={recoveryId || defaultId}
            onChange={(e) => (setRecoveryId(e.target.value), setRecoveryIdErr(null))}
          />
        )}
      </Field>
      <Button disabled={busy} onClick={() => void sendChallenge()}>
        {tr("auth.recovery.sendChallenge")}
      </Button>
      {challengeSent && (
        <>
          <Banner live="polite">{tr("auth.recovery.challengeSent")}</Banner>
          <Form className="form" onSubmit={submitRecovery}>
            <Field label={tr("auth.recovery.code")} required={null}>
              {(p) => (
                <TextInput
                  {...p}
                  readOnly={busy}
                  className="code"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={savedRecoveryCode}
                  onChange={(e) => setSavedRecoveryCode(normalizeCode(e.target.value))}
                />
              )}
            </Field>
            <Field label={tr("auth.recovery.contactCode")} required={null}>
              {(p) => (
                <TextInput
                  {...p}
                  readOnly={busy}
                  className="code"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={contactCode}
                  onChange={(e) => setContactCode(normalizeCode(e.target.value))}
                  onKeyDown={(e) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229) && !busy && submitRecovery()}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" disabled={busy || !savedRecoveryCode.trim() || !contactCode.trim()}>
              {tr("auth.recovery.submit")}
            </Button>
          </Form>
        </>
      )}
    </div>
  );
}
