// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { Checklist } from "@console/api/pending";
import type { components } from "@console/api/schema";
import { cursorPages, readIdentity } from "../lib/query";
import { PagePhase } from "../ui/page/page-scope";
import { HomeScreen } from "./home-screen";

type Item = components["schemas"]["ActionInboxItem"];
type Action = (item: Item) => ReactNode;
const state = vi.hoisted(() => ({
  settled: false,
  inbox: { data: undefined as { pages: { setup?: Checklist; items: Item[] }[] } | undefined, isPending: true, isError: false, isFetching: true, isFetchedAfterMount: false },
  entities: { isSuccess: false, isFetching: true, isError: false },
  units: { isSuccess: false, isFetching: true, isError: false },
  phase: { isPending: false, isFetching: false, isError: false },
  access: { isPending: false, isFetching: false, isError: false },
  settings: { isPending: false, isFetching: false, isError: false },
  receiptArriving: false,
  options: undefined as ReturnType<typeof cursorPages> | undefined,
  action: undefined as Action | undefined,
  reads: [] as { path: string; enabled: boolean }[], hold: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => initial === false ? [state.settled, (settled: boolean) => { state.settled = settled; }] : react.useState(initial) };
});
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useInfiniteQuery: (options: ReturnType<typeof cursorPages>) => { state.options = options; return state.inbox; },
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled: boolean }) => {
    const path = String(JSON.parse(readIdentity(options))[0]);
    if (path === "/api/v1/access/me") return state.access;
    if (path === "/api/v1/settings") return state.settings;
    state.reads.push({ path, enabled: options.enabled });
    return path === "/api/v1/org-units" ? state.units : state.entities;
  },
}));
vi.mock("../features/onboarding/ui/use-setup", () => ({ useSetupChecklist: () => ({ phaseQ: state.phase }) }));
vi.mock("../features/onboarding/ui/use-receipt", () => ({ useReceipt: () => ({ arriving: state.receiptArriving }) }));
vi.mock("../features/onboarding/ui/setup-receipt", () => ({ SetupReceipt: () => null }));
vi.mock("../ui/skeleton/skeleton", () => ({ ReadSkeleton: () => createElement("div", { "data-pending": "true" }) }));
vi.mock("../lib/live/hold", () => ({ useLiveHold: (on: boolean, notice: boolean) => state.hold(on, notice) }));
vi.mock("../features/home/Home", () => ({ Home: ({ setupPending, setup, action }: { setupPending?: boolean; setup: (c: Checklist) => ReactNode; action?: Action }) => {
  state.action = action;
  return createElement("div", { "data-pending": String(!!setupPending) }, !setupPending && setup({ total: 2 } as Checklist));
} }));
vi.mock("../features/onboarding/ui/setup-home", () => ({ SetupHome: ({ c }: { c: Checklist }) => createElement("div", { "data-testid": "setup" }, c.total) }));
vi.mock("../features/org/ui/inbox-command", () => ({ InboxCommand: ({ id, command }: { id: string; command: string }) => createElement("div", { "data-command": command, "data-record": id }) }));
vi.mock("../features/onboarding/ui/add-passkey", () => ({ AddPasskey: ({ count, primary }: { count: number; primary?: boolean }) => createElement("div", { "data-passkeys": count, className: primary ? "btn btn--primary" : "btn" }) }));
const checklist = { total: 2 } as Checklist;
const render = () => { state.reads = []; return renderToStaticMarkup(<HomeScreen />); };
const landed = (setup?: Checklist) => { state.inbox = { data: { pages: [{ setup, items: [] }] }, isPending: false, isError: false, isFetching: false, isFetchedAfterMount: true }; };
beforeEach(() => {
  vi.clearAllMocks();
  state.phase = { isPending: false, isFetching: false, isError: false };
  state.access = { isPending: false, isFetching: false, isError: false };
  state.settings = { isPending: false, isFetching: false, isError: false };
  state.receiptArriving = false;
  state.settled = false; state.options = undefined; state.action = undefined;
  state.inbox = { data: undefined, isPending: true, isError: false, isFetching: true, isFetchedAfterMount: false };
  state.entities = { isSuccess: false, isFetching: true, isError: false };
  state.units = { isSuccess: false, isFetching: true, isError: false };
});

test("the first inbox and its setup references hold Home until its first complete paint", () => {
  expect(render()).toContain('data-pending="true"');
  expect(state.hold).toHaveBeenLastCalledWith(false, true);
  expect(state.options && readIdentity(state.options)).toBe(readIdentity(cursorPages("/api/v1/me/action-inbox", { filter: "turn", attention: "all" })));
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
  expect(state.hold).toHaveBeenLastCalledWith(false, true);
});

test("an inbox without setup enables no setup references or live hold", () => {
  landed();
  expect(render()).toContain('data-pending="false"');
  expect(state.reads).toHaveLength(2);
  expect(state.reads.every((read) => !read.enabled)).toBe(true);
  expect(state.hold).toHaveBeenLastCalledWith(false, true);
});

test("a go-live receipt still arriving holds Home: its counts and actions land above the queue", () => {
  landed();
  state.receiptArriving = true;
  expect(render()).toContain('data-pending="true"');
  state.receiptArriving = false;
  expect(render()).toContain('data-pending="false"');
});

test("a receipt record the phase calls for once the band decides is still waited on: Home's arrival latches after the hold", () => {
  landed();
  const view = (settled: boolean) => renderToStaticMarkup(<PagePhase value={{ slot: null, settled }}><HomeScreen /></PagePhase>);
  state.receiptArriving = true;
  expect(view(false)).toContain('data-pending="false"');
  expect(state.settled).toBe(false);
  expect(view(true)).toContain('data-pending="true"');
  state.receiptArriving = false;
  expect(view(true)).toContain('data-pending="false"');
  expect(state.settled).toBe(true);
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
  expect(state.hold).toHaveBeenLastCalledWith(false, true);
});

test.each(["inbox", "entities", "units"] as const)("a first-read %s error releases the hold for the screen's error state", (source) => {
  landed(checklist);
  state[source].isError = true;
  expect(render()).toContain('data-pending="false"');
  expect(state.hold).toHaveBeenLastCalledWith(false, true);
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
  expect(renderToStaticMarkup(state.action!(item({ kind: "account_security", links: [{ kind: "account", id: "me" }] })))).not.toContain("btn--primary");
});

test("an inline command needs both the server verb and its registered record link", () => {
  landed(); render();
  expect(state.action).toBeTypeOf("function");
  expect(renderToStaticMarkup(state.action!(item({ context: { command: "approve" }, links: [{ kind: "employee", id: "record" }] })))).toBe("");
  expect(renderToStaticMarkup(state.action!(item({ kind: "org_change_draft" })))).toBe("");
});

test("setup rows already drawn in the rail leave Home open to changes from other sessions", () => {
  landed(checklist);
  state.entities = state.units = { isSuccess: true, isFetching: false, isError: false };
  state.inbox.data!.pages[0]!.items = [item({ kind: "setup_entity" })];
  render();
  expect(state.hold).toHaveBeenLastCalledWith(false, true);
  state.inbox.data!.pages[0]!.items.push(item());
  render();
  expect(state.hold).toHaveBeenLastCalledWith(true, true);
});

test("only painted queue rows need a live hold", () => {
  landed();
  state.inbox.data!.pages[0]!.items = [item()];
  render();
  expect(state.hold).toHaveBeenLastCalledWith(true, true);
});

test("Home lays out its content during the shared hold and starts live updates after reveal", () => {
  landed(); state.inbox.data!.pages[0]!.items = [item()];
  const view = (settled: boolean) => renderToStaticMarkup(<PagePhase value={{ slot: null, settled }}><HomeScreen /></PagePhase>);
  expect(view(false)).toContain('data-pending="false"');
  expect(state.hold).toHaveBeenLastCalledWith(false, true);
  expect(view(true)).toContain('data-pending="false"');
  expect(state.hold).toHaveBeenLastCalledWith(true, true);
  state.phase.isFetching = state.access.isFetching = state.settings.isFetching = true;
  expect(view(true)).toContain('data-pending="false"');
});
