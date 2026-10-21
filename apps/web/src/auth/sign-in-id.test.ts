import { beforeEach, expect, test, vi } from "vitest";
import { autofillPaused, forgetDomains, parseSignInId, pauseAutofill, rememberDomain, rememberedDomains, resumeAutofill } from "./sign-in-id";

/** A Map-backed Storage (the tests run in Node, which has none). */
const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
beforeEach(() => (vi.stubGlobal("localStorage", storage()), vi.stubGlobal("sessionStorage", storage())));

test("a full sign-in ID is read case-insensitively; a bare login is completed or asks", () => {
  expect(parseSignInId(" Hong@ACME ", [])).toEqual({ kind: "ok", id: "hong@acme", domain: "acme" });
  expect(parseSignInId("hong", ["acme"])).toEqual({ kind: "ok", id: "hong@acme", domain: "acme" });
  expect(parseSignInId("hong", ["acme", "beta"])).toEqual({ kind: "pick", login: "hong", domains: ["acme", "beta"] });
  expect(parseSignInId("hong", [])).toEqual({ kind: "needDomain" });
  expect(parseSignInId("홍길동@acme", [])).toEqual({ kind: "invalid", nonAscii: true });
  for (const bad of ["ho..ng@acme", "hong@a", "hong@-acme", ".hong"]) expect(parseSignInId(bad, ["acme"]), bad).toEqual({ kind: "invalid", nonAscii: false });
});

test("this browser keeps domains only, newest first, and forgets them on sign-out here", () => {
  rememberDomain("acme");
  rememberDomain("beta");
  rememberDomain("acme");
  expect(rememberedDomains()).toEqual(["acme", "beta"]);
  localStorage.setItem("console.signIn.domains", "not json");
  expect(rememberedDomains()).toEqual([]);
  rememberDomain("acme");
  forgetDomains();
  expect(rememberedDomains()).toEqual([]);
});

test("storage that throws (private mode) keeps nothing and breaks nothing", () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
  vi.stubGlobal("localStorage", broken);
  vi.stubGlobal("sessionStorage", broken);
  rememberDomain("acme");
  pauseAutofill();
  expect(rememberedDomains()).toEqual([]);
  expect(autofillPaused()).toBe(false);
});

test("a verified current domain replaces the retired domain after alias sign-in", () => {
  rememberDomain("old-company");
  rememberDomain("other-company");
  rememberDomain("current-company", "old-company");
  expect(rememberedDomains()).toEqual(["current-company", "other-company"]);
});

test("a sign-out pauses autofill in this tab until the next sign-in", () => {
  expect(autofillPaused()).toBe(false);
  pauseAutofill();
  expect(autofillPaused()).toBe(true);
  resumeAutofill();
  expect(autofillPaused()).toBe(false);
});
