// SPDX-License-Identifier: LicenseRef-Proprietary
import { runInNewContext } from "node:vm";
import type { Page } from "@playwright/test";
import { expect, test, vi } from "vitest";
import { virtualAuthenticator } from "../e2e/auth";

async function install(publicKeyCredential: unknown) {
  let initialize = () => {};
  const context = {
    browser: () => ({ browserType: () => ({ name: () => "webkit" }) }),
    credentials: { install: vi.fn() },
    exposeBinding: vi.fn(),
    addInitScript: (fn: () => void) => { initialize = fn; },
  };
  await virtualAuthenticator({ context: () => context } as unknown as Page);
  const signCount = vi.fn();
  const credentials = { create: vi.fn(), get: vi.fn() };
  const realm = {
    PublicKeyCredential: publicKeyCredential,
    navigator: { credentials: { ...credentials } },
    window: { __e2eSignCount: signCount },
    atob, btoa, Uint8Array, DataView,
  };
  runInNewContext(`(${initialize.toString()})()`, realm);
  return { realm, credentials, pkc: realm.PublicKeyCredential as typeof PublicKeyCredential, signCount };
}

test("the context authenticator supplies WebAuthn JSON APIs on Linux WebKit", async () => {
  // Linux WebKit exposes the capability object without a native credential prototype or JSON helpers.
  const { pkc } = await install({ isConditionalMediationAvailable: async () => false });
  const descriptor = { type: "public-key" as const, id: "-_8", transports: ["internal" as const] };
  const request = pkc.parseRequestOptionsFromJSON({ challenge: "AQI", allowCredentials: [descriptor], timeout: 500 });
  expect([...new Uint8Array(request.challenge as ArrayBuffer)]).toEqual([1, 2]);
  expect([...new Uint8Array(request.allowCredentials![0]!.id as ArrayBuffer)]).toEqual([251, 255]);
  expect(request.allowCredentials![0]!.transports).toEqual(["internal"]);
  expect(request.timeout).toBe(500);
  const options = { challenge: "AQI", rp: { name: "Console" }, user: { id: "AwQ", name: "admin", displayName: "Admin" }, pubKeyCredParams: [{ type: "public-key" as const, alg: -7 }], excludeCredentials: [descriptor] };
  const creation = pkc.parseCreationOptionsFromJSON(options);
  expect([...new Uint8Array(creation.user.id as ArrayBuffer)]).toEqual([3, 4]);
  expect([...new Uint8Array(creation.excludeCredentials![0]!.id as ArrayBuffer)]).toEqual([251, 255]);
  expect(creation.rp).toEqual(options.rp);
  const credential = { id: "-_8", type: "public-key", response: { clientDataJSON: new Uint8Array([1, 2]).buffer, attestationObject: new Uint8Array([3, 4]).buffer } };
  expect(pkc.prototype.toJSON.call(credential as unknown as PublicKeyCredential)).toMatchObject({ id: "-_8", rawId: "-_8", response: { clientDataJSON: "AQI", attestationObject: "AwQ" } });
});

test("injected assertions serialize their buffers and retain the signature counter", async () => {
  const { realm, credentials, signCount } = await install({});
  const authenticatorData = new ArrayBuffer(37);
  new DataView(authenticatorData).setUint32(33, 7);
  credentials.get.mockResolvedValue({ id: "AQI", type: "public-key", response: { clientDataJSON: new Uint8Array([1, 2]).buffer, authenticatorData, signature: new Uint8Array([251, 255]).buffer, userHandle: null } });
  const credential = await realm.navigator.credentials.get();
  expect(credential.toJSON()).toMatchObject({ id: "AQI", response: { clientDataJSON: "AQI", signature: "-_8", userHandle: undefined } });
  expect(signCount).toHaveBeenCalledWith("AQI", 7);
});

test("the context authenticator preserves native JSON helpers", async () => {
  class Credential {
    static parseRequestOptionsFromJSON = vi.fn();
    static parseCreationOptionsFromJSON = vi.fn();
    toJSON() { return {}; }
  }
  const request = Credential.parseRequestOptionsFromJSON;
  const create = Credential.parseCreationOptionsFromJSON;
  const json = Credential.prototype.toJSON;
  const { pkc } = await install(Credential);
  expect(pkc.parseRequestOptionsFromJSON).toBe(request);
  expect(pkc.parseCreationOptionsFromJSON).toBe(create);
  expect(pkc.prototype.toJSON).toBe(json);
});
