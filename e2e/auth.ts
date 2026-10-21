import { createPrivateKey, createPublicKey } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";

/**
 * A passkey in CDP's WebAuthn.Credential shape (binaries as base64). Both engines export and import it, so a
 * kept passkey (e2e/flows.ts) moves between Chromium and Firefox workers on one database.
 */
type Passkey = { credentialId: string; isResidentCredential: boolean; rpId?: string; privateKey: string; userHandle?: string; signCount: number };
export type Authenticator = {
  /** Detaches this authenticator from the page (its passkeys are no longer offered). */
  remove: () => Promise<unknown>;
  /** Drops every passkey this authenticator holds (before importing newer copies). */
  clear: () => Promise<unknown>;
  /** The passkeys this authenticator holds (to carry a user across test workers). */
  export: () => Promise<Passkey[]>;
  import: (passkeys: Passkey[]) => Promise<void>;
};
const byPage = new WeakMap<Page, Authenticator>();
/** The authenticator a page signed in with (set by virtualAuthenticator). */
export const authenticatorOf = (page: Page) => byPage.get(page)!;

/** A virtual platform authenticator: real WebAuthn ceremonies without a device. Call it before the page's first goto. */
export async function virtualAuthenticator(page: Page) {
  const authn = page.context().browser()?.browserType().name() === "chromium" ? await cdpAuthenticator(page) : await contextAuthenticator(page);
  byPage.set(page, authn);
  return authn;
}

/** Chromium: a CDP virtual authenticator attached to this page. */
async function cdpAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true },
  });
  return {
    remove: () => cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }),
    clear: () => cdp.send("WebAuthn.clearCredentials", { authenticatorId }),
    export: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
    import: async (passkeys) => {
      for (const credential of passkeys) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
    },
  };
}

const b64 = (s: string) => Buffer.from(s, "base64url").toString("base64");
const b64url = (s: string) => Buffer.from(s, "base64").toString("base64url");
/** Each context's live signature counters by credential id, as its pages report them. */
const counters = new WeakMap<BrowserContext, Map<string, number>>();

/**
 * Other engines: Playwright's context.credentials (one store per context, so remove = clear). Its credentials
 * lack a signature counter: create() starts at 0 and get() hides it, while the server refuses a counter that does
 * not move forward. So pages report each assertion's counter, and import replays assertions up to the kept one.
 */
async function contextAuthenticator(page: Page): Promise<Authenticator> {
  const context = page.context();
  let counts = counters.get(context);
  if (!counts) {
    const live = (counts = new Map());
    counters.set(context, live);
    await context.credentials.install();
    await context.exposeBinding("__e2eSignCount", (_, id: string, n: number) => void live.set(id, n));
    await context.addInitScript(rebuildToJSON);
  }
  const clear = async () => {
    for (const { id } of await context.credentials.get()) await context.credentials.delete(id);
  };
  return {
    remove: clear,
    clear,
    export: async () =>
      (await context.credentials.get()).map((c) => ({
        credentialId: b64(c.id),
        isResidentCredential: true,
        rpId: c.rpId,
        privateKey: b64(c.privateKey),
        userHandle: b64(c.userHandle),
        signCount: counts.get(c.id) ?? 0,
      })),
    import: async (passkeys) => {
      for (const p of passkeys) {
        const key = createPrivateKey({ key: Buffer.from(p.privateKey, "base64"), format: "der", type: "pkcs8" });
        const { id, rpId } = await context.credentials.create(p.rpId ?? "localhost", {
          id: b64url(p.credentialId),
          privateKey: b64url(p.privateKey),
          publicKey: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url"),
          userHandle: b64url(p.userHandle ?? ""),
        });
        // Each assertion moves the stored counter up by one; nothing reaches the server.
        await page.evaluate(
          async ({ id, rpId, n }) => {
            const rawId = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
            for (let i = 0; i < n; i++)
              await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16), rpId, allowCredentials: [{ type: "public-key", id: rawId }] } });
          },
          { id, rpId, n: p.signCount },
        );
        counts.set(id, p.signCount);
      }
    },
  };
}

/**
 * Page init script: Playwright 1.63's injected credential has a stub toJSON(), so rebuild it from the response
 * buffers (the app posts toJSON()), and report each assertion's signature counter to the test.
 */
function rebuildToJSON() {
  const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const wrap = (name: "create" | "get") => {
    const orig = navigator.credentials[name].bind(navigator.credentials);
    navigator.credentials[name] = async (o?: CredentialCreationOptions & CredentialRequestOptions) => {
      const c = (await orig(o)) as PublicKeyCredential | null;
      if (!c) return c;
      const r = c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
      let response;
      if (name === "create") response = { clientDataJSON: b64u(r.clientDataJSON), attestationObject: b64u(r.attestationObject), transports: ["internal"] };
      else {
        await (window as unknown as { __e2eSignCount: (id: string, n: number) => Promise<void> }).__e2eSignCount(c.id, new DataView(r.authenticatorData).getUint32(33)); // after the 32-byte rpIdHash and the flags byte
        response = { clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature), userHandle: r.userHandle ? b64u(r.userHandle) : undefined };
      }
      const json = { id: c.id, rawId: c.id, type: c.type, authenticatorAttachment: "platform", clientExtensionResults: {}, response };
      Object.defineProperty(c, "toJSON", { value: () => json, configurable: true });
      return c;
    };
  };
  wrap("create");
  wrap("get");
}
