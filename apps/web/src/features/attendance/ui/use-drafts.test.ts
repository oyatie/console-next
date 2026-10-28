// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { keepDraft, readDrafts, saveDrafts } from "./use-drafts";
import { draftKey, recoveryDraftText, syncDraftPrincipal } from "../../../lib/react/use-draft";

const account = vi.hoisted(() => ({ principal: "account-a" as string | null }));
vi.mock("@console/api", async original => ({ ...await original<typeof import("@console/api")>(), session: { get principal() { return account.principal; } } }));
beforeEach(() => { account.principal = "account-a"; });
afterEach(() => { syncDraftPrincipal(null); vi.unstubAllGlobals(); });
const scope = "2026-10";
const key = draftKey("account-a", "attendance", scope, "grid");
const legacy = `console.attendance.drafts:${scope}`;
const draft = { "employee|2026-10-01": { value: "9-18", base: null } };
function storage(raw: string | null) {
  const values: Record<string, string> = { "console.draft.principal": "account-a", ...(raw === null ? {} : { [key]: raw }) };
  const methods = {
    getItem: vi.fn((k: string) => values[k] ?? null),
    setItem: vi.fn((k: string, v: string) => { values[k] = v; }),
    removeItem: vi.fn((k: string) => { delete values[k]; }),
  };
  const store = new Proxy(values, { get: (target, k) => k in methods ? methods[k as keyof typeof methods] : Reflect.get(target, k) }) as unknown as typeof methods;
  vi.stubGlobal("sessionStorage", store);
  return store;
}

test("drafts survive reload, stay scoped and saved cells are removed", () => {
  const store = storage(null);
  expect(saveDrafts(scope, { now: draft, readProblem: null })).toBeNull();
  expect(readDrafts(scope)).toEqual({ now: draft, readProblem: null });
  expect(readDrafts("other").now).toEqual({});
  expect(saveDrafts(scope, { now: {}, readProblem: null })).toBeNull();
  expect(store.getItem(key)).toBeNull();
});

test("account change purges attendance storage and recovery text before another account reads", () => {
  const store = storage(null);
  saveDrafts(scope, { now: draft, readProblem: null });
  syncDraftPrincipal("account-b");
  account.principal = "account-b";
  expect(readDrafts(scope).now).toEqual({});
  expect(store.getItem(key)).toBeNull();
  expect(store.getItem(legacy)).toBeNull();
  expect(recoveryDraftText()).toBe("");
});

test("attendance contributes one recovery line per cell, including an offscreen scope", () => {
  storage(null);
  saveDrafts(scope, { now: draft, readProblem: null }, "account-a", [{ employee_id: "employee", name: "김초안" }]);
  keepDraft("day:2026-10-02", "other|2026-10-02", { value: "9-17", base: null });
  expect(recoveryDraftText()).toBe("2026-10-01 · 김초안 · 9-18\n\n2026-10-02 · 9-17");
  saveDrafts(scope, { now: {}, readProblem: null });
  expect(recoveryDraftText()).not.toContain("9-18");
});

test("a legacy row is deleted even when the current account matches the owner marker", () => {
  const store = storage(null);
  store.setItem(legacy, JSON.stringify(draft));
  expect(readDrafts(scope).now).toEqual({});
  expect(store.getItem(legacy)).toBeNull();
  expect(store.getItem(key)).toBeNull();
});

test("account B cannot adopt account A's legacy row after signing in on the old bundle", () => {
  const store = storage(null);
  store.setItem(legacy, JSON.stringify(draft));
  store.setItem("console.draft.principal", "account-b");
  account.principal = "account-b";
  expect(readDrafts(scope, "account-b").now).toEqual({});
  expect(store.getItem(legacy)).toBeNull();
  expect(store.getItem(draftKey("account-b", "attendance", scope, "grid"))).toBeNull();
  expect(recoveryDraftText()).toBe("");
});

test("same-account sync purges every legacy scope before returning and preserves owned drafts", () => {
  const store = storage(JSON.stringify(draft));
  store.setItem(legacy, JSON.stringify(draft));
  store.setItem("console.attendance.drafts:unopened", JSON.stringify(draft));
  expect(syncDraftPrincipal("account-a")).toBeNull();
  expect(store.getItem(legacy)).toBeNull();
  expect(store.getItem("console.attendance.drafts:unopened")).toBeNull();
  expect(store.getItem(key)).toBe(JSON.stringify(draft));
  expect(store.getItem("console.draft.principal")).toBe("account-a");
});

test.each(["account-b", null])("a legacy row with owner %s is deleted without disclosure", owner => {
  const store = storage(null);
  if (owner) store.setItem("console.draft.principal", owner);
  else store.removeItem("console.draft.principal");
  store.setItem(legacy, JSON.stringify(draft));
  expect(readDrafts(scope).now).toEqual({});
  expect(store.getItem(legacy)).toBeNull();
  expect(store.getItem(key)).toBeNull();
});

test("legacy rows in scopes never opened are purged on account change", () => {
  const store = storage(null);
  store.setItem(legacy, JSON.stringify(draft));
  syncDraftPrincipal("account-b");
  expect(store.getItem(legacy)).toBeNull();
});

test("legacy cleanup leaves an owned draft intact", () => {
  const store = storage(JSON.stringify(draft));
  store.setItem(legacy, JSON.stringify({ "other|2026-10-01": { value: "old", base: null } }));
  expect(readDrafts(scope).now).toEqual(draft);
  expect(store.getItem(legacy)).toBeNull();
  expect(store.getItem(key)).toBe(JSON.stringify(draft));
});

test("legacy rows are deleted without adoption even when storage is full", () => {
  const store = storage(null);
  store.setItem(legacy, JSON.stringify(draft));
  store.setItem.mockImplementation(() => { throw new Error("quota"); });
  expect(readDrafts(scope)).toEqual({ now: {}, readProblem: null });
  expect(store.getItem(legacy)).toBeNull();
  expect(store.setItem).toHaveBeenCalledTimes(1);
  expect(recoveryDraftText()).toBe("");
});

test.each(["account-b", null])("delayed saves for account A cannot recreate purged drafts after owner becomes %s", principal => {
  const store = storage(JSON.stringify(draft));
  syncDraftPrincipal(principal);
  account.principal = principal;
  expect(saveDrafts(scope, { now: draft, readProblem: null }, "account-a")).toBe("unavailable");
  expect(store.getItem(key)).toBeNull();
  expect(recoveryDraftText()).toBe("");
});

test.each(["account-b", null])("delayed offscreen edits do not even read account A's store after owner becomes %s", principal => {
  const store = storage(null);
  account.principal = principal;
  const read = store.getItem;
  expect(keepDraft(scope, "employee|2026-10-01", draft["employee|2026-10-01"], "account-a")).toBe("unavailable");
  expect(read).not.toHaveBeenCalled();
  expect(store.setItem).not.toHaveBeenCalled();
});

test("malformed drafts are reported and their original survives edits and cleanup", () => {
  for (const raw of ["{broken", "null", "[]", '"text"', '{"x":{"value":5,"base":null}}', '{"x":{"value":"=","base":false}}']) {
    const store = storage(raw);
    const loaded = readDrafts(scope);
    expect(loaded).toEqual({ now: {}, readProblem: "unreadable" });
    expect(saveDrafts(scope, { ...loaded, now: draft })).toBe("unreadable");
    expect(saveDrafts(scope, loaded)).toBe("unreadable");
    expect(store.getItem(key)).toBe(raw);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
  }
});

test("unavailable reads, quota writes and cleanup failures are reported without changing memory drafts", () => {
  const store = storage(null);
  store.setItem.mockImplementation(() => { throw new Error("quota"); });
  const state = { now: draft, readProblem: null };
  expect(saveDrafts(scope, state)).toBe("unavailable");
  expect(state.now).toEqual(draft);
  store.removeItem.mockImplementation(() => { throw new Error("denied"); });
  expect(saveDrafts(scope, { ...state, now: {} })).toBe("unavailable");
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("denied"); } });
  expect(readDrafts(scope)).toEqual({ now: {}, readProblem: "unavailable" });
});

// Regression (P0, draft lost): an editor whose view moved to another month or unit while typing kept its value in the
// scope on screen, invisible there and missing on return. It is kept in the scope it was typed in, beside its drafts.
test("a draft kept for a scope not on screen joins that scope's drafts and never another scope's", () => {
  const store = storage(JSON.stringify(draft));
  const typed = { value: "9-1", base: "e1" };
  expect(keepDraft(scope, "other|2026-10-02", typed)).toBeNull();
  expect(readDrafts(scope).now).toEqual({ ...draft, "other|2026-10-02": typed });
  expect(readDrafts("2026-11").now).toEqual({});
  expect(store.setItem).toHaveBeenCalledTimes(1);
});

test("a draft that cannot be kept for its scope says so and leaves an unreadable original alone", () => {
  const store = storage("{broken");
  expect(keepDraft(scope, "other|2026-10-02", { value: "9-1", base: null })).toBe("unreadable");
  expect(store.getItem(key)).toBe("{broken");
  expect(store.setItem).not.toHaveBeenCalled();
  storage(null).setItem.mockImplementation(() => { throw new Error("quota"); });
  expect(keepDraft(scope, "other|2026-10-02", { value: "9-1", base: null })).toBe("unavailable");
});
