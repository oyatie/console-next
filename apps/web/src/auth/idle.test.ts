import { afterEach, expect, test, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { api, interactionHeaders, lastTouch, session } from "@console/api";
import { ACTIVITY_REPORT_MS, idleCutoff, lastActive, watchSession } from "./idle";
import { draftKey, readDraft, syncDraftPrincipal } from "../lib/react/use-draft";

const MIN = 60_000;
const jwt = (sub: string) => `h.${btoa(JSON.stringify({ sub, org: "o1", roles: ["HR_ADMIN"], platform: false, read_only: false })).replace(/=+$/, "")}.s`;
const pair = (sub: string) => ({ access_token: jwt(sub), token_type: "Bearer" as const, refresh_expires_at: "2027-01-01T00:00:00Z", requires_passkey_setup: false });
afterEach(() => vi.unstubAllGlobals());

test("the warning shows from the lead before the server's cut-off, and only with a known input and timeout", () => {
  const last = 1_000_000;
  const at = last + 30 * MIN;
  // Before the lead: nothing. Inside it, to the last millisecond: the cut-off the warning names.
  expect(idleCutoff(last, 30 * MIN, at - 2 * MIN - 1, 2 * MIN)).toBeNull();
  expect(idleCutoff(last, 30 * MIN, at - 2 * MIN, 2 * MIN)).toBe(at);
  expect(idleCutoff(last, 30 * MIN, at - 1, 2 * MIN)).toBe(at);
  // At the cut-off and past it (a tab resumed or reloaded hours later): never a time already gone, only "ended".
  expect(idleCutoff(last, 30 * MIN, at, 2 * MIN)).toBe("ended");
  expect(idleCutoff(last, 30 * MIN, at + 1, 2 * MIN)).toBe("ended");
  expect(idleCutoff(last, 30 * MIN, last + 3 * 60 * MIN, 2 * MIN)).toBe("ended");
  expect(idleCutoff(null, 30 * MIN, last, 2 * MIN)).toBeNull();
  expect(idleCutoff(last, null, last + 60 * MIN, 2 * MIN)).toBeNull();
});

test("input counts only when trusted, is shared with other tabs, and a lost session keeps cache and screen", () => {
  const handlers: Record<string, (e: Event) => void> = {};
  vi.stubGlobal("document", { addEventListener: (type: string, h: (e: Event) => void) => void (handlers[type] = h) });
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  const assign = vi.fn();
  vi.stubGlobal("location", { assign });
  const qc = { clear: vi.fn(), invalidateQueries: vi.fn(async () => undefined) };
  const signedOut = vi.fn();
  watchSession(qc as unknown as QueryClient, signedOut);

  handlers.keydown!({ isTrusted: false } as Event); // a widget's synthetic key
  expect(lastTouch()).toBeNull();
  handlers.pointerdown!({ isTrusted: true } as Event);
  expect(lastTouch()).not.toBeNull();
  expect(Number(store.get("console.lastInteraction"))).toBe(lastTouch());
  store.set("console.lastInteraction", String(lastTouch()! + 60_000)); // another tab, later
  expect(lastActive()).toBe(lastTouch()! + 60_000);

  session.set(pair("u1"));
  expect(qc.clear).toHaveBeenCalledTimes(1);
  session.set(pair("u1")); // a token rotation is not a change of person
  session.expire();
  expect(session.lost).toBe(true);
  expect(qc.clear).toHaveBeenCalledTimes(1);
  expect(signedOut).not.toHaveBeenCalled();
  expect(qc.invalidateQueries).not.toHaveBeenCalled();

  session.set(pair("u1")); // the same person signs back in: shown data is re-read, nothing dropped
  expect(qc.invalidateQueries).toHaveBeenCalledTimes(1);
  expect(qc.clear).toHaveBeenCalledTimes(1);

  session.expire();
  session.set(pair("u2")); // someone else signs in over it: a reload, so no draft of u1 survives
  expect(assign).toHaveBeenCalledWith("/");
  assign.mockClear();
  session.set(pair("u3")); // a changed refresh-cookie account also drops the mounted screen
  expect(assign).toHaveBeenCalledWith("/");

  session.set(null); // a sign-out
  expect(signedOut).toHaveBeenCalledTimes(1);
  expect(session.lost).toBe(false);
});

test("anonymous expiry keeps public screens, and sign-out is one principal transition", () => {
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  session.set(null);
  const qc = { clear: vi.fn(), invalidateQueries: vi.fn(async () => undefined) };
  const signedOut = vi.fn();
  watchSession(qc as unknown as QueryClient, signedOut);

  session.expire();
  expect(signedOut).not.toHaveBeenCalled();
  expect(qc.clear).not.toHaveBeenCalled();
  session.set(pair("u-public"));
  session.set(null);
  expect(signedOut).toHaveBeenCalledTimes(1);
  expect(qc.clear).toHaveBeenCalledTimes(2);
  session.expire();
  expect(signedOut).toHaveBeenCalledTimes(1);
  expect(qc.clear).toHaveBeenCalledTimes(2);
});

test.each(["draft-user", "another-user"])("an expired cold reload keeps drafts until %s is identified", (nextUser) => {
  session.set(null); // a new page has no in-memory claims yet
  vi.stubGlobal("document", { addEventListener: vi.fn() });
  const values: Record<string, string> = {};
  const store = Object.defineProperties(values, {
    getItem: { value: (key: string) => values[key] ?? null },
    setItem: { value: (key: string, value: string) => { values[key] = value; } },
    removeItem: { value: (key: string) => { delete values[key]; } },
  }) as unknown as Storage;
  vi.stubGlobal("sessionStorage", store);
  const owner = JSON.stringify(["o1", "draft-user"]);
  const key = draftKey(owner, "/people/$id", "person", "exit.report");
  const initial = { note: "" };
  const yours = { note: "unfinished report" };
  syncDraftPrincipal(owner);
  store.setItem(key, JSON.stringify({ base: initial, yours }));
  watchSession({ clear: vi.fn(), invalidateQueries: vi.fn() } as unknown as QueryClient, vi.fn());

  session.expire("session_idle_expired"); // refresh refused before it could identify the account
  expect(session.principal).toBeNull();
  expect(readDraft(key, initial).yours).toEqual(yours);
  session.set(pair(nextUser));
  expect(readDraft(key, initial).yours).toEqual(nextUser === "draft-user" ? yours : initial);
  session.set(null); // explicit sign-out still discards
  expect(store.getItem(key)).toBeNull();
});

test("typing for 30 minutes with no other request reports itself once a minute; 30 idle minutes send nothing", () => {
  vi.useFakeTimers();
  const handlers: Record<string, (e: Event) => void> = {};
  vi.stubGlobal("document", { addEventListener: (type: string, h: (e: Event) => void) => void (handlers[type] = h) });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  // As the real client does: every request carries the last input (and so counts as reported).
  const sent: string[] = [];
  const ping = vi.spyOn(api, "GET").mockImplementation((async () => {
    sent.push(interactionHeaders()["x-last-interaction"] ?? "none");
    return {};
  }) as never);
  watchSession({ clear: vi.fn(), invalidateQueries: vi.fn(async () => undefined) } as unknown as QueryClient, vi.fn());
  session.set(null);
  handlers.keydown!({ isTrusted: true } as Event); // signed out: nothing to keep
  session.set(pair("u9"));
  vi.advanceTimersByTime(ACTIVITY_REPORT_MS);
  sent.length = 0;
  vi.advanceTimersByTime(30 * MIN); // idle: no input, no request (decision #27)
  expect(sent).toEqual([]);
  handlers.keydown!({ isTrusted: false } as Event); // a widget's synthetic key is not the user
  expect(sent).toEqual([]);
  for (let s = 0; s < 30 * 60; s += 20) {
    handlers.keydown!({ isTrusted: true } as Event); // a key every 20 s
    vi.advanceTimersByTime(20_000);
  }
  expect(sent).toHaveLength(30);
  expect(sent.every((h) => h !== "none")).toBe(true);
  ping.mockRestore();
  session.set(null);
  vi.useRealTimers();
});
