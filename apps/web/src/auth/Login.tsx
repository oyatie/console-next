import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { ApiError, lastSignInId, lastSignInProfile, loginWithPasskey, logout, passkeyAutofill, redeemOtp, session } from "@console/api";
import { t } from "@console/i18n";
import { signInError } from "../lib/refusal";
import { Banner } from "../ui/banner/banner";
import { Button, Form } from "../ui/button/button";
import { Field, TextInput } from "../ui/field/field";
import { PageHead } from "../ui/page-head/page-head";
import { IDLE_EXPIRED } from "./idle";
import { autofillPaused, parseSignInId, rememberDomain, rememberedDomains, resumeAutofill } from "./sign-in-id";

export { SetupPasskey } from "./SetupPasskey";

const loginRoute = getRouteApi("/login");

/** The server's one-time code: 8 case-sensitive characters (provisioning `OTP_LEN`), never whitespace. */
export const OTP_LENGTH = 8;
/** Typed or pasted text as a code: whitespace a messenger copy adds is dropped, then capped at the code length. */
export const normalizeOtp = (text: string) => text.replace(/\s/g, "").slice(0, OTP_LENGTH);

/** Where to turn after a failed sign-in: a rejected code, or no passkey on this device. */
type Recovery = "code" | "passkey" | null;
const codeRecovery = (e: unknown): Recovery => (e instanceof ApiError && e.status === 401 ? "code" : null);
const passkeyRecovery = (e: unknown): Recovery => (signInError(e) === null ? "passkey" : null);

/**
 * The browser's passkey autofill on the sign-in ID field (LS-C38, decisions #33): one conditional request from mount,
 * renewed before its ceremony expires, aborted before any modal ceremony (a pending one makes the next fail). Not
 * started after a sign-out or a failed sign-in in this tab (auth/sign-in-id.ts) until the next sign-in.
 */
function useAutofill(signedIn: () => Promise<void>) {
  const pending = useRef<AbortController | null>(null);
  // Set once a modal ceremony starts or the screen leaves: a start still awaiting the feature check then stays out.
  const stopped = useRef(false);
  const cancel = () => {
    pending.current?.abort();
    pending.current = null;
  };
  const start = useRef(async () => {
    if (pending.current || !(await passkeyAutofill()) || stopped.current || pending.current) return;
    const ctl = (pending.current = new AbortController());
    let renew: ReturnType<typeof setTimeout> | undefined;
    const onStart = (expiresAt: string) => {
      renew = setTimeout(() => (cancel(), void start.current()), Math.max(0, Date.parse(expiresAt) - Date.now() - 15_000));
    };
    try {
      await loginWithPasskey({ mediation: "conditional", signal: ctl.signal, onStart });
      await signedIn();
    } catch (e) {
      void e;
      // Conditional autofill is passive: failures are never displayed as error banners (issue #44).
    } finally {
      clearTimeout(renew);
      if (pending.current === ctl) pending.current = null;
    }
  });
  const stop = useCallback(() => {
    stopped.current = true;
    pending.current?.abort();
    pending.current = null;
  }, []);
  useEffect(() => {
    stopped.current = false;
    if (!autofillPaused()) void start.current();
    return stop;
  }, [stop]);
  return stop;
}

export function Login() {
  const nav = useNavigate();
  const { enrolled } = loginRoute.useSearch();
  const [otp, setOtp] = useState("");
  const [id, setId] = useState("");
  const [idError, setIdError] = useState<string | null>(null);
  const [pick, setPick] = useState<{ login: string; domains: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<Recovery>(null);
  // A reload (or a new tab) after the server ended the session for inactivity lands here: say why.
  const idle = useSyncExternalStore(session.subscribe, () => session.ended === IDLE_EXPIRED);

  const signedIn = async () => {
    // A code redeemed by someone who already has a passkey, for example: this session can go nowhere.
    if (session.stage === "stale") {
      await logout();
      setError(t("auth.login.stale"));
      return;
    }
    const submittedDomain = lastSignInId()?.split("@")[1];
    const profile = lastSignInProfile();
    if (!profile || profile.user_id === session.claims?.sub) {
      const currentDomain = profile?.name.split("@")[1] ?? submittedDomain;
      if (currentDomain) rememberDomain(currentDomain, submittedDomain);
    }
    resumeAutofill();
    await nav({ to: session.stage === "enroll" ? "/setup-passkey" : session.claims?.platform ? "/platform" : "/" });
  };
  const abortAutofill = useAutofill(signedIn);
  const run = async (fn: () => Promise<void>, onFail: (e: unknown) => Recovery) => {
    abortAutofill();
    setBusy(true);
    setError(null);
    setRecovery(null);
    try {
      await fn();
      await signedIn();
    } catch (e) {
      setError(signInError(e));
      setRecovery(onFail(e));
    } finally {
      setBusy(false);
    }
  };
  const submitOtp = () => {
    // A short code is refused before it spends one of the client's rate-limited attempts.
    if (otp.length === OTP_LENGTH) void run(() => redeemOtp(otp), codeRecovery);
  };
  // Identifier first: the challenge names this account's passkeys, so a security key with no resident slot works.
  const signInAs = (identifier: string) => run(() => loginWithPasskey({ identifier }), passkeyRecovery);
  const submitId = () => {
    const parsed = parseSignInId(id, rememberedDomains());
    setPick(parsed.kind === "pick" ? parsed : null);
    setIdError(
      parsed.kind === "invalid" ? t(parsed.nonAscii ? "auth.login.id.nonAscii" : "auth.login.id.invalid") : parsed.kind === "needDomain" ? t("auth.login.id.needDomain") : null,
    );
    if (parsed.kind === "ok") void signInAs(parsed.id);
  };

  return (
    <main className="auth">
      <div className="card auth__card">
        <PageHead title={t("auth.login.title")} />
        {/* `enrolled`: the passkey is registered; only the automatic sign-in after enrollment failed. */}
        {error && (
          <Banner tone="danger" live="assertive">
            {error}
            {recovery === "code" && <div>{t("auth.login.codeRejected")}</div>}
          </Banner>
        )}
        {/* No usable passkey here: one message for every account state (no enumeration), naming every way on. */}
        {!error && recovery === "passkey" && <Banner live="polite">{t("auth.login.noPasskey")}</Banner>}
        {/* A next step, not an error: the passkey is registered and only the automatic sign-in after enrollment
            failed, or the server ended the last session for inactivity. */}
        {!error && (enrolled || idle) && <Banner live="polite">{t(enrolled ? "auth.login.enrolled" : "auth.login.idle")}</Banner>}
        <Form className="form" onSubmit={submitId}>
          <Field label={t("auth.login.id")} required={null} hint={t("auth.login.idHint")} error={idError ?? undefined}>
            {/* `username webauthn`: the browser offers the passkey from this field's autofill. */}
            {(p) => (
              <TextInput
                {...p}
                autoComplete="username webauthn"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                value={id}
                onChange={(e) => (setId(e.target.value), setIdError(null), setPick(null))}
              />
            )}
          </Field>
          {pick && (
            <div className="row" role="group" aria-label={t("auth.login.id.pick")}>
              {pick.domains
                .map((d) => ({ d, full: [pick.login, d].join("@") }))
                .map(({ d, full }) => (
                  <Button key={d} disabled={busy} onClick={() => void signInAs(full)}>
                    {full}
                  </Button>
                ))}
            </div>
          )}
          <Button type="submit" variant="primary" disabled={busy}>{t("auth.login.continue")}</Button>
        </Form>
        <Button disabled={busy} onClick={() => run(() => loginWithPasskey(), passkeyRecovery)}>
          <KeyRound size={16} aria-hidden /> {t("auth.login.passkey")}
        </Button>
        <div className="auth__or">{t("auth.login.or")}</div>
        <Form className="form" onSubmit={submitOtp}>
          <Field label={t("auth.login.code")} required={null} hint={t("auth.login.codeHint", { count: otp.length, length: OTP_LENGTH })}>
            {/* No autocapitalize or autocorrect: the code is case-sensitive, and a capitalized first letter always fails.
                Enter submits: the code is this form's one field (a free-text box elsewhere never does). */}
            {(p) => (
              <TextInput
                {...p}
                className="code"
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={otp}
                onChange={(e) => setOtp(normalizeOtp(e.target.value))}
                onKeyDown={(e) => e.key === "Enter" && !(e.nativeEvent.isComposing || e.keyCode === 229) && !busy && submitOtp()}
              />
            )}
          </Field>
          <Button type="submit" disabled={busy || otp.length !== OTP_LENGTH}>{t("auth.login.submitCode")}</Button>
        </Form>
      </div>
    </main>
  );
}
