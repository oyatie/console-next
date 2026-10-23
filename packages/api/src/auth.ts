import { api, unwrap } from "./client";
import type { components } from "./schema";
import { authPost, clearStoredRefresh, session, storedRefresh, type TokenPair } from "./session";
import { platform, type PasskeyGet } from "./platform";

type Ceremony = components["schemas"]["PasskeyLoginStartResponse"];
type Assertion = components["schemas"]["PasskeyStepUpAssertion"];
// webauthn-rs serialises challenges as `{ publicKey: {...} }` with base64url fields.
type WebauthnJson<K extends string, T> = { [P in K]: T };
const START = "/api/v1/auth/passkey/login/start";

export async function redeemOtp(otp: string) {
  const tokens = await authPost<TokenPair>("/api/v1/auth/otp/redeem", { otp });
  signedInAs = undefined;
  signInProfile = undefined;
  session.set(tokens);
}

/** The browser's prompt (or its autofill) for one server challenge. */
async function assertWith(start: Ceremony, how?: PasskeyGet): Promise<Assertion> {
  const { publicKey } = start.challenge as WebauthnJson<"publicKey", PublicKeyCredentialRequestOptionsJSON>;
  const credential = await platform().passkeys.get(publicKey, how);
  if (!credential) throw new Error("passkey_cancelled");
  return { ceremony_id: start.ceremony_id, credential: credential as Record<string, unknown> };
}

/**
 * A fresh assertion of one of the signed-in caller's own passkeys, before a sensitive change. The bearer makes the
 * server name the caller's passkeys in the challenge (decisions #33), so a security key without a resident slot works.
 */
export const assertPasskey = async (): Promise<Assertion> => assertWith(await authPost<Ceremony>(START, {}, true));

/**
 * Passkey sign-in. With `identifier` (`login@domain`) the challenge names that account's passkeys; without one it is
 * usernameless (the passkey sign-in button), or the browser's autofill with `mediation: "conditional"`.
 */
export async function loginWithPasskey(opts: { identifier?: string; onStart?: (expiresAt: string) => void } & PasskeyGet = {}) {
  const { identifier, onStart, ...how } = opts;
  const start = await authPost<Ceremony>(START, identifier ? { identifier } : {});
  onStart?.(start.expires_at);
  const done = await authPost<TokenPair>("/api/v1/auth/passkey/login/finish", await assertWith(start, how));
  signedInAs = identifier;
  signInProfile = done.passkey_profile;
  session.set(done);
  const rpId = (start.challenge as WebauthnJson<"publicKey", PublicKeyCredentialRequestOptionsJSON>).publicKey.rpId;
  if (rpId && signInProfile) {
    const bytes = signInProfile.user_id.replaceAll("-", "").match(/../g)!.map((b) => Number.parseInt(b, 16));
    const userId = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    await platform().passkeys.signalCurrentUserDetails?.({ rpId, userId, name: signInProfile.name, displayName: signInProfile.display_name });
  }
}

/** The sign-in ID this page last signed in with, in memory only: re-auth names the same passkeys (a non-resident one). */
let signedInAs: string | undefined;
let signInProfile: TokenPair["passkey_profile"];
export const lastSignInProfile = () => signInProfile;
export const lastSignInId = () => signedInAs;

/** Whether this platform offers passkeys from the sign-in field's autofill. */
export const passkeyAutofill = async () => (await platform().passkeys.autofill?.()) ?? false;

/** Thrown when initial enrollment registered the passkey but the sign-in with it then failed (e.g. rate-limited). */
export const PASSKEY_ENROLLED = "passkey_enrolled_signin_failed";

/**
 * Initial enrollment omits step_up; adding a further passkey requires a fresh assertion. Resolves to the account's
 * sign-in ID (`login@domain`), so the web app can remember the domain for the next sign-in.
 */
export async function registerPasskey(opts: { stepUp?: boolean } = {}): Promise<string | null> {
  const step_up = opts.stepUp ? await assertPasskey() : undefined;
  const start = await authPost<Ceremony>("/api/v1/auth/passkey/register/start", { step_up }, true);
  const { publicKey } = start.challenge as WebauthnJson<"publicKey", PublicKeyCredentialCreationOptionsJSON>;
  // residentKey "preferred" (decisions #33): a security key with no free slot keeps a server-side credential.
  const credential = await platform().passkeys.create(publicKey);
  if (!credential) throw new Error("passkey_cancelled");
  const done = await authPost<components["schemas"]["PasskeyRegisterFinishResponse"]>(
    "/api/v1/auth/passkey/register/finish",
    { ceremony_id: start.ceremony_id, credential },
    true,
  );
  if (opts.stepUp) return done.sign_in_id ?? null; // already a passkey session
  // Initial enrollment: the OTP-derived session ends here (revoked server-side, cookie cleared) and the new
  // passkey signs in identifier-first (it may be non-resident), so the app runs on a passkey session.
  await authPost("/api/v1/auth/logout", { refresh_token: await storedRefresh() });
  try {
    await loginWithPasskey({ identifier: done.sign_in_id ?? undefined });
  } catch (e) {
    session.set(null); // the passkey is enrolled; sign-in continues from the login screen
    throw new Error(PASSKEY_ENROLLED, { cause: e });
  }
  return done.sign_in_id ?? null;
}

export async function logout() {
  signedInAs = undefined;
  signInProfile = undefined;
  // Native: the server revokes the refresh family only when the token is in the body (web: the cookie).
  await authPost("/api/v1/auth/logout", { refresh_token: await storedRefresh() }).catch(() => undefined);
  await clearStoredRefresh();
  session.set(null);
}

export type ConsentStatus = components["schemas"]["PrivacyConsentStatusResponse"];
type ConsentDocuments = components["schemas"]["TermsDocument"];
/** Exact immutable texts, readable by app and enrollment sessions. */
export const consentDocuments = () => unwrap(api.GET("/api/v1/onboarding/terms"));
/** Read required privacy/terms acceptance status. */
export const consentStatus = () => authPost<ConsentStatus>("/api/v1/auth/privacy-consent/status", undefined, true);

/** Accept the exact text that was displayed, with separate required sign-offs. */
export const acceptConsent = async (documents: ConsentDocuments) => {
  const principal = session.principal;
  const status = await authPost<ConsentStatus>("/api/v1/auth/privacy-consent/accept", {
    privacy: { version: documents.privacy.version, sha256: documents.privacy.sha256 },
    terms: { version: documents.version, sha256: documents.sha256 },
    privacy_collection: true, terms_of_service: true,
  }, true);
  if (session.principal === principal) session.setConsentAccepted(status.accepted);
  return status;
};
