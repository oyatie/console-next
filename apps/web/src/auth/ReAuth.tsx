import { useState, useSyncExternalStore } from "react";
import { Copy, KeyRound, LogOut } from "lucide-react";
import { lastSignInId, loginWithPasskey, logout, session } from "@console/api";
import { t } from "@console/i18n";
import { ActionBar } from "../ui/action-bar/action-bar";
import { Button } from "../ui/button/button";
import { Dialog } from "../ui/dialog";
import { TextArea } from "../ui/field/text-area";
import { PasskeyError } from "../lib/react/passkey-error";
import { recoveryDraftText } from "../lib/react/use-draft";
import { sessionRecovery } from "./session-recovery";

/** Sign in again over the screen the session ended on; signing out instead discards what was typed. */
export default function ReAuth() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reason = useSyncExternalStore(session.subscribe, () => session.ended);
  const recovery = sessionRecovery(reason);
  const draftText = recoveryDraftText();
  const [copyStatus, setCopyStatus] = useState<"copied" | "copyFailed" | null>(null);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const copy = async () => {
    const text = recoveryDraftText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("copyFailed");
      setManualCopy(text);
    }
  };
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      // The same account's passkeys when this page signed in by sign-in ID (a non-resident key needs them named).
      await loginWithPasskey({ identifier: lastSignInId() });
      // Passkeys reset under this session: only a fresh sign-in recovers it (the sign-in screen).
      if (session.stage !== "app") await logout();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open title={t("idle.reauth.title")} onClose={() => undefined} dismissable={false}>
      <span>{t(!draftText && !recovery.passkey ? `${recovery.message}.bare` : recovery.message)}</span>
      {recovery.passkey && <span className="muted">{t("idle.reauth.other")}</span>}
      <PasskeyError error={error} />
      <span role="status">{draftText && copyStatus ? t(`idle.reauth.${copyStatus}`) : null}</span>
      {manualCopy !== null && <TextArea aria-label={t("idle.reauth.copy")} readOnly value={manualCopy} onFocus={(e) => e.target.select()} />}
      <ActionBar
        actions={
          <>
            {/* The dialog opens on its first control: signing in again, never signing out. */}
            {recovery.passkey && <Button variant="primary" disabled={busy} onClick={() => void signIn()}>
              <KeyRound size={16} aria-hidden /> {t("idle.reauth.signIn")}
            </Button>}
            {draftText && <Button onClick={() => void copy()}>
              <Copy size={16} aria-hidden /> {t("idle.reauth.copy")}
            </Button>}
            <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
              <LogOut size={16} aria-hidden /> {t("idle.reauth.signOut")}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
