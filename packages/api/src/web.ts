import type { Platform } from "./platform";

/** WebAuthn rejects a dismissed or timed-out prompt (NotAllowedError/AbortError): that is a cancel, not an error. */
const cancelled = (e: unknown) => {
  if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError")) return null;
  throw e;
};

/**
 * Passkeys need the WebAuthn JSON helpers (desktop Chrome 129+, Firefox 119+). Checked before any ceremony, so
 * an older or stripped-down browser gets "passkey_unavailable" (an update message) instead of a TypeError that
 * reads as a network fault. Capability check, never UA sniffing.
 * refuses where DSK-W1's JSON shim would run instead; restore the shim here when Safari / iOS
 * below 18.4 is supported again (OD-BR-1).
 */
const requirePasskeys = () => {
  const pkc = globalThis.PublicKeyCredential;
  if (!pkc || !navigator.credentials || typeof pkc.parseRequestOptionsFromJSON !== "function" || typeof pkc.parseCreationOptionsFromJSON !== "function" || typeof pkc.prototype.toJSON !== "function")
    throw new Error("passkey_unavailable");
};

/** How long a tab waits for another tab's refresh (OD-BR-2: one same-origin request; the value is an estimate). */
const REFRESH_LOCK_WAIT_MS = 10_000;

/** Browser platform: same-origin API, cookie refresh transport, native WebAuthn JSON APIs. */
export const webPlatform: Platform = {
  baseUrl: "",
  refresh: { kind: "cookie" },
  passkeys: {
    async get(options, how = {}) {
      requirePasskeys();
      const cred = (await navigator.credentials
        .get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options), ...how })
        .catch(cancelled)) as PublicKeyCredential | null;
      return cred?.toJSON() ?? null;
    },
    // A feature check (browser-support.md rule 2): the browser says whether its autofill offers passkeys.
    autofill: async () => (await globalThis.PublicKeyCredential?.isConditionalMediationAvailable?.().catch(() => false)) ?? false,
    async signalCurrentUserDetails(options) {
      const pkc = globalThis.PublicKeyCredential as typeof PublicKeyCredential & {
        signalCurrentUserDetails?: (options: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
      };
      if (!pkc?.signalCurrentUserDetails) return false;
      // A password manager may reject or omit Signal; this never invalidates a successful sign-in.
      return pkc.signalCurrentUserDetails(options).then(() => true, () => false);
    },
    async create(options) {
      requirePasskeys();
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(options);
      const cred = (await navigator.credentials.create({ publicKey }).catch(cancelled)) as PublicKeyCredential | null;
      return cred?.toJSON() ?? null;
    },
  },
  // The lock is held until the rotated Set-Cookie has landed, so a waiting tab sends the new cookie.
  // A tab frozen mid-refresh can hold it indefinitely, so a waiter gives up after REFRESH_LOCK_WAIT_MS and refreshes
  // unguarded. Only when the lock was never granted: request() also rejects with fn's own error, and re-running a
  // refresh that already rotated server-side trips reuse detection. No branch on the error name (Chromium 103–123
  // reject a timed-out request with AbortError, later versions with TimeoutError).
  // without Web Locks (insecure origin, pre-2022 browser), or after the wait, tabs refresh unguarded; add a BroadcastChannel fallback if such a deployment appears.
  withRefreshLock: async (fn) => {
    if (!navigator.locks) return fn();
    let started = false;
    try {
      return await navigator.locks.request("console-refresh", { signal: AbortSignal.timeout(REFRESH_LOCK_WAIT_MS) }, () => {
        started = true;
        return fn();
      });
    } catch (e) {
      if (!started) return fn();
      throw e;
    }
  },
};
