import { afterEach, expect, test, vi } from "vitest";
import { keepDraft, readDrafts, saveDrafts } from "./use-drafts";

afterEach(() => vi.unstubAllGlobals());
const scope = "2026-10";
const key = `console.attendance.drafts:${scope}`;
const draft = { "employee|2026-10-01": { value: "9-18", base: null } };
function storage(raw: string | null) {
  const values = new Map(raw === null ? [] : [[key, raw]]);
  const store = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => { values.set(k, v); }),
    removeItem: vi.fn((k: string) => { values.delete(k); }),
  };
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
