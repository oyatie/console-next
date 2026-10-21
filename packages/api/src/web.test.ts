import { afterEach, expect, test, vi } from "vitest";
import { webPlatform } from "./web";

afterEach(() => vi.unstubAllGlobals());

const options = {} as PublicKeyCredentialRequestOptionsJSON;
/** A browser with WebAuthn; `helpers: false` is one before the JSON helpers (Chrome < 129, Firefox < 119). */
function browser({ helpers }: { helpers: boolean }) {
  const get = vi.fn(async () => ({ toJSON: () => ({ id: "cred" }) }));
  const statics = helpers ? { parseRequestOptionsFromJSON: (o: unknown) => o, parseCreationOptionsFromJSON: (o: unknown) => o } : {};
  vi.stubGlobal("PublicKeyCredential", Object.assign(() => undefined, statics, { prototype: helpers ? { toJSON() {} } : {} }));
  vi.stubGlobal("navigator", { credentials: { get, create: get } });
  return get;
}

test("a browser without the WebAuthn JSON helpers is refused before any ceremony, never with a TypeError", async () => {
  const get = browser({ helpers: false });
  await expect(webPlatform.passkeys.get(options)).rejects.toThrow("passkey_unavailable");
  await expect(webPlatform.passkeys.create(options as never)).rejects.toThrow("passkey_unavailable");
  expect(get).not.toHaveBeenCalled();
});

test("a browser without WebAuthn at all is refused the same way", async () => {
  vi.stubGlobal("navigator", {});
  await expect(webPlatform.passkeys.get(options)).rejects.toThrow("passkey_unavailable");
});

test("a browser with the helpers runs the ceremony", async () => {
  const get = browser({ helpers: true });
  expect(await webPlatform.passkeys.get(options)).toEqual({ id: "cred" });
  expect(get).toHaveBeenCalledTimes(1);
});

test("Signal updates the current verified labels and degrades on unavailable or rejecting managers", async () => {
  const profile = { rpId: "example.com", userId: "uuid-bytes", name: "hong@new-domain", displayName: "Hong · Company — hong@new-domain" };
  vi.stubGlobal("PublicKeyCredential", {});
  expect(await webPlatform.passkeys.signalCurrentUserDetails!(profile)).toBe(false);
  const signal = vi.fn(async () => undefined);
  vi.stubGlobal("PublicKeyCredential", { signalCurrentUserDetails: signal });
  expect(await webPlatform.passkeys.signalCurrentUserDetails!(profile)).toBe(true);
  expect(signal).toHaveBeenCalledWith(profile);
  signal.mockRejectedValueOnce(new DOMException("manager rejected", "NotAllowedError"));
  expect(await webPlatform.passkeys.signalCurrentUserDetails!(profile)).toBe(false);
});
