import { useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { lastSignInId, loginWithPasskey, logout, session } from "@console/api";
import { t } from "@console/i18n";
import { ActionBar } from "../ui/action-bar/action-bar";
import { Button } from "../ui/button/button";
import { Dialog } from "../ui/dialog";
import { PasskeyError } from "../lib/react/passkey-error";
import { IDLE_EXPIRED } from "./idle";

/** Sign in again over the screen the session ended on; signing out instead discards what was typed. */
export default function ReAuth() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
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
      {/* Why it ended, from the server's refusal: inactivity, or anything else (signed out elsewhere, ended). */}
      <span>{t(session.ended === IDLE_EXPIRED ? "idle.reauth.idle" : "idle.reauth.body")}</span>
      <span className="muted">{t("idle.reauth.other")}</span>
      <PasskeyError error={error} />
      <ActionBar
        actions={
          <>
            {/* The dialog opens on its first control: signing in again, never signing out. */}
            <Button variant="primary" disabled={busy} onClick={() => void signIn()}>
              <KeyRound size={16} aria-hidden /> {t("idle.reauth.signIn")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void logout()}>
              <LogOut size={16} aria-hidden /> {t("idle.reauth.signOut")}
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
