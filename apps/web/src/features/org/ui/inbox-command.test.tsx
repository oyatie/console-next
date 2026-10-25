// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, type MouseEvent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { APPROVAL_ROLE, label } from "../../../lib/labels";
import { get, readIdentity } from "../../../lib/query";
import type { Button } from "../../../ui/button/button";
import { InboxCommand } from "./inbox-command";

type Detail = components["schemas"]["OrgChangeDetail"];
type Command = { run: () => Promise<unknown>; invalidates: readonly string[]; onSuccess: () => void };
const state = vi.hoisted(() => ({
  units: { items: [{ id: "from", headcount: 5 }] } as { items: { id: string; headcount: number }[] } | undefined,
  unitsFetching: false, unitsFailed: false, unitsFresh: true, snapshots: [] as unknown[],
  detail: undefined as Detail | undefined, fetching: false, pending: false, open: false, error: null as unknown,
  buttons: [] as Parameters<typeof Button>[0][], command: undefined as Command | undefined,
  decide: vi.fn(), effectuate: vi.fn(), focus: vi.fn(), mutate: vi.fn(), reads: [] as string[],
}));
vi.mock("react", async original => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => initial === false ? [state.open, (open: boolean) => { state.open = open; }] : actual.useState(initial) };
});
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: (query: Parameters<typeof readIdentity>[0]) => {
  const path = String(JSON.parse(readIdentity(query))[0]);
  state.reads.push(path);
  if (path === "/api/v1/org-units") return { data: state.units, isSuccess: !!state.units && !state.unitsFailed, isFetchedAfterMount: state.unitsFresh, isFetching: state.unitsFetching, error: state.unitsFailed ? new Error("headcount unavailable") : null };
  return { data: state.detail, isSuccess: !!state.detail, isPending: !state.detail, isFetching: state.fetching, error: null, refetch: vi.fn() };
} }));
vi.mock("../api", () => ({
  changeQuery: (id: string) => get("/api/v1/org-changes/{id}", { params: { path: { id } } }),
  changeCommands: (id: string) => ({ decide: (...args: unknown[]) => state.decide(id, ...args), effectuate: () => state.effectuate(id) }),
}));
vi.mock("../../../lib/react/announce", () => ({ focusSoon: (...args: unknown[]) => state.focus(...args) }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (options: Command) => {
  state.command = options;
  return { mutate: state.mutate, isPending: state.pending, error: state.error };
} }));
vi.mock("../../../lib/react/command-error", () => ({ CommandError: ({ error }: { error: unknown }) => error ? createElement("div", { role: "alert" }, String(error)) : null }));
vi.mock("./effectuate-consequence", () => ({ EffectuateConsequence: ({ d, headcount }: { d: Detail; headcount?: unknown }) => { state.snapshots.push(headcount); return createElement("span", null, t("org.change.effectuate.apply", { code: d.code })); } }));
vi.mock("../../../ui/dialog", () => ({ Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? createElement("div", { role: "dialog" }, children) : null }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { state.buttons.push(props); return createElement(actual.Button, props); } };
});
const detail = (): Detail => ({
  id: "change", code: "OC-2026-0012", kind: "REORG", status: "IN_APPROVAL", target: { kind: "ORG_UNIT", ref: "unit", label: "인사부" },
  effectiveDate: "2026-10-23", reason: "부서 개편", headcount: 3, siteCount: 1, teamCount: 1, draftedBy: "drafter", draftedByName: "기안자", createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
  proposal: [], settlementItems: [], events: [], approvalSteps: [
    { id: "previous", stepOrder: 1, roleKey: "hr", decision: "APPROVED", decidedByName: "담당자" },
    { id: "next", stepOrder: 2, roleKey: "finance", decision: "PENDING", decidedByName: null },
  ],
});
const render = (command: "approve" | "effectuate") => {
  state.buttons = [];
  return renderToStaticMarkup(<InboxCommand id="change" command={command} />);
};
const click = (button: Parameters<typeof Button>[0]) => button.onClick!({} as MouseEvent<HTMLButtonElement>);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  vi.clearAllMocks();
  state.units = { items: [{ id: "from", headcount: 5 }] }; state.unitsFetching = false; state.unitsFailed = false; state.unitsFresh = true; state.snapshots = [];
  state.detail = detail(); state.fetching = false; state.pending = false; state.open = false; state.error = null; state.command = undefined; state.reads = [];
});

test("inline approval sends the current pending step and refreshes the inbox with focus recovered", async () => {
  const markup = render("approve");
  expect(markup).toContain(t("orgChange.turn", { role: label(APPROVAL_ROLE, "finance") }));
  expect(state.reads).toEqual(["/api/v1/org-changes/{id}", "/api/v1/org-units"]);
  const approve = state.buttons[0]!;
  expect(approve.disabled).toBe(false);
  click(approve);
  expect(state.mutate).toHaveBeenCalledWith(undefined);
  await state.command!.run();
  expect(state.decide).toHaveBeenCalledWith("change", "next", "APPROVED");
  expect(state.effectuate).not.toHaveBeenCalled();
  expect(state.command!.invalidates).toContain("/api/v1/me/action-inbox");
  expect(state.command!.invalidates).toContain("/api/v1/org-changes");
  state.command!.onSuccess();
  expect(state.focus).toHaveBeenCalledWith("inbox-title");
});

test.each(["missing", "fetching", "pending"] as const)("approval stays disarmed while its step is %s", (reason) => {
  if (reason === "missing") state.detail!.approvalSteps = [];
  if (reason === "fetching") state.fetching = true;
  if (reason === "pending") state.pending = true;
  render("approve");
  expect(state.buttons[0]!.disabled).toBe(true);
  expect(state.mutate).not.toHaveBeenCalled();
});

test("effectuation loads its consequence with the row and sends only after inline confirmation", async () => {
  const markup = render("effectuate");
  expect(markup).toContain(t("org.change.effectuate.apply", { code: "OC-2026-0012" }));
  expect(markup).not.toContain('role="dialog"');
  click(state.buttons[0]!);
  expect(state.mutate).not.toHaveBeenCalled();
  const dialog = render("effectuate");
  expect(dialog).toContain('role="dialog"');
  click(state.buttons.at(-1)!);
  expect(state.mutate).toHaveBeenCalledWith(undefined);
  await state.command!.run();
  expect(state.effectuate).toHaveBeenCalledWith("change");
  expect(state.decide).not.toHaveBeenCalled();
  expect(state.command!.invalidates).toEqual(expect.arrayContaining(["/api/v1/me/action-inbox", "/api/v1/org-changes", "/api/v1/employees", "/api/v1/employment-assignments"]));
  state.command!.onSuccess();
  expect(state.open).toBe(false);
  expect(state.focus).toHaveBeenCalledWith("inbox-title");
});

test("an unread or refreshing consequence cannot be confirmed and a command failure stays visible", () => {
  state.detail = undefined;
  render("effectuate");
  expect(state.buttons[0]!.disabled).toBe(true);
  state.units = { items: [{ id: "from", headcount: 5 }] }; state.unitsFetching = false; state.unitsFailed = false; state.unitsFresh = true; state.snapshots = [];
  state.detail = detail(); state.fetching = true; state.open = true; state.error = new Error("write refused");
  expect(render("effectuate")).toContain("write refused");
  expect(state.buttons.at(-1)!.disabled).toBe(true);
  expect(state.mutate).not.toHaveBeenCalled();
});


test.each(["missing", "fetching", "failed", "cached"] as const)("moving people cannot be confirmed with %s headcount", (stateOfRead) => {
  state.detail!.proposal = [{ op: "REASSIGN_ORG_UNIT", fromOrgUnit: "from", toOrgUnit: "to", scope: { company: "company" } }];
  if (stateOfRead === "missing") state.units = undefined;
  if (stateOfRead === "fetching") state.unitsFetching = true;
  if (stateOfRead === "failed") state.unitsFailed = true;
  if (stateOfRead === "cached") state.unitsFresh = false;
  render("effectuate");
  expect(state.buttons[0]!.disabled).toBe(true);
  state.open = true;
  render("effectuate");
  expect(state.buttons.at(-1)!.disabled).toBe(true);
});

test("the row and confirmation disclose the same freshly read headcount", () => {
  state.detail!.proposal = [{ op: "REASSIGN_ORG_UNIT", fromOrgUnit: "from", toOrgUnit: "to", scope: { company: "company" } }];
  render("effectuate");
  expect(state.buttons[0]!.disabled).toBe(false);
  click(state.buttons[0]!);
  render("effectuate");
  expect(state.snapshots).toHaveLength(3);
  for (const snapshot of state.snapshots) expect(snapshot).toBe(state.units);
});
