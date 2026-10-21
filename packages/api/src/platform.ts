/**
 * Everything that differs between the web app and the Expo app. The rest of this package
 * is platform-neutral so both clients share one API layer.
 */
export type Platform = {
  /** Origin of the API. Web uses same-origin (""), native an absolute URL. */
  baseUrl: string;
  /**
   * Refresh-token transport. Web: the backend sets an HttpOnly `console_refresh` cookie
   * (`x-auth-transport: cookie`) and JS never sees the token, so load/save are no-ops.
   * Native: the token comes back in the body and lives in the OS keystore.
   */
  refresh:
    | { kind: "cookie" }
    | { kind: "body"; load(): Promise<string | null>; save(token: string | null): Promise<void> };
  /** WebAuthn ceremonies over the backend's JSON (base64url) option/credential shapes. */
  passkeys: {
    get(options: PublicKeyCredentialRequestOptionsJSON, how?: PasskeyGet): Promise<unknown | null>;
    create(options: PublicKeyCredentialCreationOptionsJSON): Promise<unknown | null>;
    /** Whether the platform offers passkeys from a field's autofill (conditional mediation). Absent: never. */
    autofill?(): Promise<boolean>;
    signalCurrentUserDetails?(options: { rpId: string; userId: string; name: string; displayName: string }): Promise<boolean>;
  };
  /**
   * Runs a refresh-token rotation exclusively across every context that shares the refresh token.
   * Web: tabs share the cookie, and two rotations of the same token trip the server's reuse
   * detection, which revokes the whole family (signs the user out). Omit it where one process owns
   * the token (React Native): refresh() then runs `fn` directly.
   */
  withRefreshLock?<T>(fn: () => Promise<T>): Promise<T>;
};

/** How a `get` runs: `conditional` waits for the person to pick a passkey from the field's autofill (decisions #33). */
export type PasskeyGet = { mediation?: "conditional"; signal?: AbortSignal };

let current: Platform | null = null;
export function setPlatform(p: Platform) {
  current = p;
}
export function platform(): Platform {
  if (!current) throw new Error("@console/api: call configure() before use");
  return current;
}
