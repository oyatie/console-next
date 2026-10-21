// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { draftKey, readDraft, syncDraftPrincipal } from "./use-draft";

const initial = { date: "", note: "", reason: null as string | null };
const yours = { date: "2026-11-20", note: "unfinished", reason: "R1" };
const key = draftKey("account-a", "/people/$id", "record", "exit.report");
function storage() {
  const values: Record<string, string> = {};
  const store = new Proxy(values, { get: (target, k) => {
    if (k === "getItem") return (name: string) => target[name] ?? null;
    if (k === "setItem") return (name: string, value: string) => { target[name] = value; };
    if (k === "removeItem") return (name: string) => { delete target[name]; };
    return Reflect.get(target, k);
  } }) as unknown as Storage;
  vi.stubGlobal("sessionStorage", store);
  return store;
}
afterEach(() => vi.unstubAllGlobals());

test("base and input restore only under the same account, route, record and form", () => {
  const store = storage();
  syncDraftPrincipal("account-a");
  store.setItem(key, JSON.stringify({ base: initial, yours }));
  expect(readDraft(key, initial)).toEqual({ base: initial, yours, restored: true, problem: null });
  for (const other of [draftKey("account-b", "/people/$id", "record", "exit.report"), draftKey("account-a", "/other", "record", "exit.report"), draftKey("account-a", "/people/$id", "other", "exit.report"), draftKey("account-a", "/people/$id", "record", "other")]) {
    expect(readDraft(other, initial).yours).toEqual(initial);
  }
  syncDraftPrincipal("account-a"); // same-account re-auth / renewal keeps the draft
  expect(store.getItem(key)).not.toBeNull();
  syncDraftPrincipal("account-b");
  expect(store.getItem(key)).toBeNull();
  syncDraftPrincipal("account-a");
  expect(readDraft(key, initial).yours).toEqual(initial);
});

test("explicit sign-out purges all drafts without touching other session storage", () => {
  const store = storage();
  syncDraftPrincipal("account-a");
  store.setItem(key, JSON.stringify({ base: initial, yours }));
  store.setItem("unrelated", "keep");
  syncDraftPrincipal(null);
  expect(store.getItem(key)).toBeNull();
  expect(store.getItem("unrelated")).toBe("keep");
});

test.each(["{broken", "null", "[]", JSON.stringify({ base: initial, yours: { ...yours, note: 17 } }), JSON.stringify({ base: initial, yours: { ...yours, extra: "unknown" } })])("unreadable draft %s remains intact and is reported", (raw) => {
  const store = storage();
  store.setItem(key, raw);
  expect(readDraft(key, initial)).toMatchObject({ yours: initial, problem: "unreadable" });
  expect(store.getItem(key)).toBe(raw);
});

test("blocked storage keeps an in-memory form usable and reports its limit", () => {
  vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); } });
  expect(syncDraftPrincipal("account-a")).toBe("unavailable");
  expect(readDraft(key, initial)).toMatchObject({ yours: initial, problem: "unavailable" });
});
