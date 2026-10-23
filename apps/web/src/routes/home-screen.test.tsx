// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Checklist } from "@console/api/pending";
import type { components } from "@console/api/schema";
import { cursorPages, readIdentity } from "../lib/query";
import { HomeScreen } from "./home-screen";

type Item = components["schemas"]["ActionInboxItem"];
type Action = (item: Item) => ReactNode;
const state = vi.hoisted(() => ({
  settled: false,
  inbox: { data: undefined as { pages: { setup?: Checklist }[] } | undefined, isPending: true, isError: false, isFetching: true, isFetchedAfterMount: false },
  entities: { isSuccess: false, isFetching: true, isError: false },
  units: { isSuccess: false, isFetching: true, isError: false },
  options: undefined as ReturnType<typeof cursorPages> | undefined,
  action: undefined as Action | undefined,
  reads: [] as { path: string; enabled: boolean }[], hold: vi.fn(),
}));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: () => [state.settled, (settled: boolean) => { state.settled = settled; }] }));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useInfiniteQuery: (options: ReturnType<typeof cursorPages>) => { state.options = options; return state.inbox; },
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled: boolean }) => {
    const path = String(JSON.parse(readIdentity(options))[0]);
    state.reads.push({ path, enabled: options.enabled });
    return path === "/api/v1/org-units" ? state.units : state.entities;
  },
}));
vi.mock("../lib/live/hold", () => ({ useLiveHold: (pending: boolean) => state.hold(pending) }));
vi.mock("../features/home/Home", () => ({ Home: ({ setupPending, setup, action }: { setupPending?: boolean; setup: (c: Checklist) => ReactNode; action?: Action }) => {
  state.action = action;
  return createElement("div", { "data-pending": String(setupPending) }, !setupPending && setup({ total: 2 } as Checklist));
} }));
vi.mock("../features/onboarding/ui/setup-home", () => ({ SetupHome: ({ c }: { c: Checklist }) => createElement("div", { "data-testid": "setup" }, c.total) }));
vi.mock("../features/org/ui/inbox-command", () => ({ InboxCommand: ({ id, command }: { id: string; command: string }) => createElement("div", { "data-command": command, "data-record": id }) }));
vi.mock("../features/onboarding/ui/add-passkey", () => ({ AddPasskey: ({ count }: { count: number }) => createElement("div", { "data-passkeys": count }) }));
const checklist = { total: 2 } as Checklist;
const render = () => { state.reads = []; return renderToStaticMarkup(<HomeScreen />); };
const landed = (setup?: Checklist) => { state.inbox = { data: { pages: [{ setup }] }, isPending: false, isError: false, isFetching: false, isFetchedAfterMount: true }; };
beforeEach(() => {
  vi.clearAllMocks();
  state.settled = false; state.options = undefined; state.action = undefined;
  state.inbox = { data: undefined, isPending: true, isError: false, isFetching: true, isFetchedAfterMount: false };
  state.entities = { isSuccess: false, isFetching: true, isError: false };
  state.units = { isSuccess: false, isFetching: true, isError: false };
});

test("the first inbox and its setup references hold Home until its first complete paint", () => {
  expect(render()).toContain('data-pending="true"');
  expect(state.hold).toHaveBeenLastCalledWith(true);
  expect(state.options && readIdentity(state.options)).toBe(readIdentity(cursorPages("/api/v1/me/action-inbox", { filter: "turn" })));
  expect(state.options).toMatchObject({ refetchOnMount: "always" });
  expect(state.reads.every((read) => !read.enabled)).toBe(true);
  landed(checklist);
  expect(render()).toContain('data-pending="true"');
  expect(state.reads).toHaveLength(2);
  expect(state.reads.every((read) => read.enabled)).toBe(true);
  state.entities = { isSuccess: true, isFetching: false, isError: false };
  expect(render()).toContain('data-pending="true"');
  state.units = { isSuccess: true, isFetching: false, isError: false };
  const complete = render();
  expect(complete).toContain('data-pending="false"');
  expect(complete).toContain('data-testid="setup"');
  expect(state.hold).toHaveBeenLastCalledWith(false);
});

test("an inbox without setup enables no setup references or live hold", () => {
  landed();
  expect(render()).toContain('data-pending="false"');
  expect(state.reads).toHaveLength(2);
  expect(state.reads.every((read) => !read.enabled)).toBe(true);
  expect(state.hold).toHaveBeenLastCalledWith(false);
});

test("a cached inbox mount refresh cannot settle setup's arrival before its current checklist", () => {
  landed(); state.inbox.isFetching = true; state.inbox.isFetchedAfterMount = false;
  expect(render()).toContain('data-pending="true"');
  expect(state.settled).toBe(false);
  landed(checklist);
  expect(render()).toContain('data-pending="true"');
});

test("after the first paint, background inbox and reference refreshes keep Home visible and live", () => {
  landed(checklist);
  state.entities = state.units = { isSuccess: true, isFetching: false, isError: false };
  render();
  state.inbox.isFetching = true; state.entities.isFetching = true; state.units.isFetching = true;
  expect(render()).toContain('data-pending="false"');
  expect(state.hold).toHaveBeenLastCalledWith(false);
});

test.each(["inbox", "entities", "units"] as const)("a first-read %s error releases the hold for the screen's error state", (source) => {
  landed(checklist);
  state[source].isError = true;
  expect(render()).toContain('data-pending="false"');
  expect(state.hold).toHaveBeenLastCalledWith(false);
});

const item = (extra: Partial<Item> = {}): Item => ({ id: "inbox-item", kind: "org_change_approve", lane: "turn", title: "조직 변경", ref: "", urg: "now", dueTone: "neutral", done: false, days_remaining: null, links: [{ kind: "org_change", id: "record" }], ...extra });

test.each(["approve", "effectuate"] as const)("Home wires the server's %s verb to its own inline command", (command) => {
  landed(); render();
  expect(state.action).toBeTypeOf("function");
  const markup = renderToStaticMarkup(state.action!(item({ context: { command } })));
  expect(markup).toContain(`data-command="${command}"`);
  expect(markup).toContain('data-record="record"');
});

test("Home's account security verb registers the second passkey inline", () => {
  landed(); render();
  expect(state.action).toBeTypeOf("function");
  expect(renderToStaticMarkup(state.action!(item({ kind: "account_security", links: [{ kind: "account", id: "me" }] })))).toContain('data-passkeys="1"');
});

test("an inline command needs both the server verb and its registered record link", () => {
  landed(); render();
  expect(state.action).toBeTypeOf("function");
  expect(renderToStaticMarkup(state.action!(item({ context: { command: "approve" }, links: [{ kind: "employee", id: "record" }] })))).toBe("");
  expect(renderToStaticMarkup(state.action!(item({ kind: "org_change_draft" })))).toBe("");
});
