import type { ChangeEvent, MouseEvent, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { Button } from "../../../ui/button/button";
import type { TextInput } from "../../../ui/field/field";
import { ApiError, type Outcome } from "../api";
import { RequestLookup, RequestPage } from "./request-page";

type Query = { isPending: boolean; error: unknown; data: Outcome | undefined; refetch: () => unknown };
const view = vi.hoisted(() => ({
  key: "", id: "original-operation-id", setKey: vi.fn(), navigate: vi.fn(), refetch: vi.fn(),
  input: undefined as Parameters<typeof TextInput>[0] | undefined,
  buttons: [] as Parameters<typeof Button>[0][],
  query: undefined as Query | undefined,
  options: undefined as Record<string, unknown> | undefined,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => initial === "" ? [view.key, view.setKey] : actual.useState(initial) };
});
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: Record<string, unknown>) => { view.options = options; return view.query; },
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({ useParams: () => ({ id: view.id }) }),
  useNavigate: () => view.navigate,
}));
// Capture the actual house controls' callbacks while retaining their SSR markup.
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { view.buttons.push(props); return <actual.Button {...props} />; } };
});
vi.mock("../../../ui/field/field", async (original) => {
  const actual = await original<typeof import("../../../ui/field/field")>();
  return { ...actual, TextInput: (props: Parameters<typeof TextInput>[0]) => { view.input = props; return <actual.TextInput {...props} />; } };
});

const created = "2026-10-09T05:00:00Z";
const deadline = "2026-10-09T05:15:00Z";
const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  id: view.id, idempotency_key: "original-transport-key", command: "POST /api/v1/command",
  state: "APPLIED", created_at: created, deadline, settled_at: created,
  inputs_masked: { secret_input: "private input" }, result: null, refusal_code: null,
  masked: false, touched: [], ...over,
});
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  vi.clearAllMocks();
  view.key = ""; view.buttons = []; view.input = undefined; view.options = undefined;
  view.setKey.mockImplementation((key: string) => { view.key = key; });
  view.query = { isPending: false, error: null, data: outcome(), refetch: view.refetch };
});
async function html(node: ReactNode = <RequestPage />) {
  const root = createRootRoute({ component: () => node });
  const lookup = createRoute({ getParentRoute: () => root, path: "/requests" });
  const request = createRoute({ getParentRoute: () => root, path: "/requests/$id" });
  const person = createRoute({ getParentRoute: () => root, path: "/people/$id" });
  const router = createRouter({ routeTree: root.addChildren([lookup, request, person]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const lookupAction = () => view.buttons.find((props) => props.children === t("requestOutcome.find"))!;
test.each(["", "x".repeat(15), "x".repeat(201), "😀".repeat(15)])("invalid lookup %s stays focusable, explains why and focuses its remedy without navigation", async (key) => {
  view.key = key;
  const markup = await html(<RequestLookup />);
  const button = markup.match(/<button[^>]*>/)![0];
  expect(button).toContain('aria-disabled="true"');
  expect(button).not.toMatch(/\sdisabled=/);
  const reasonId = button.match(/aria-describedby="([^"]+)"/)![1];
  expect(markup).toContain(`id="${reasonId}">${t("requestOutcome.invalid")}<`);
  expect(markup).toContain(`type="button"`);
  const focus = vi.fn();
  const ref = view.input!.ref;
  expect(ref && typeof ref === "object").toBe(true);
  if (ref && typeof ref === "object") ref.current = { focus } as unknown as HTMLInputElement;
  const preventDefault = vi.fn();
  lookupAction().onClick!({ preventDefault } as unknown as MouseEvent<HTMLButtonElement>);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledOnce();
  expect(view.navigate).not.toHaveBeenCalled();
});

test.each(["x".repeat(16), "x".repeat(200), "  original-transport-key  ", "😀".repeat(16)])("valid lookup %s navigates once with the trimmed key", async (key) => {
  view.key = key;
  const markup = await html(<RequestLookup />);
  expect(markup).not.toContain('aria-disabled="true"');
  lookupAction().onClick!({} as MouseEvent<HTMLButtonElement>);
  expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/requests/$id", params: { id: key.trim() } });
});

test("lookup edits preserve the house field's required label and validation hint", async () => {
  const markup = await html(<RequestLookup />);
  expect(markup).toContain(t("requestOutcome.lookup"));
  expect(markup).toContain(t("requestOutcome.invalid"));
  expect(view.input!.required).toBe(true);
  expect(view.input!["aria-describedby"]).toBeTruthy();
  view.input!.onChange!({ target: { value: "new-original-intent" } } as ChangeEvent<HTMLInputElement>);
  expect(view.setKey).toHaveBeenCalledExactlyOnceWith("new-original-intent");
  expect(view.navigate).not.toHaveBeenCalled();
});

test.each(["PROCESSING", "APPLIED", "REFUSED", "CONFLICT", "CANCELLED", "EXPIRED"] as const)("%s announces its state, shows identity/times and a lookup link without another submission", async (state) => {
  view.query!.data = outcome({ state });
  const markup = await html();
  expect(markup).toContain(`<h2 role="status">${t(`requestOutcome.${state}`)}</h2>`);
  expect(markup).toContain(view.id);
  expect(markup).toContain(fmtDateTime(created));
  expect(markup).toContain(fmtDateTime(deadline));
  if (state === "PROCESSING") expect(markup).toContain(t("requestOutcome.remedy"));
  expect(markup).toContain('href="/requests"');
  expect(markup).not.toContain("<button");
  expect(view.options).toMatchObject({ refetchOnMount: "always" });
});

test("initial loading reserves the receipt shape and announces busy", async () => {
  view.query = { isPending: true, data: undefined, error: null, refetch: view.refetch };
  const markup = await html();
  expect(markup).toContain('aria-busy="true"');
  expect(markup).toContain(`aria-label="${t("common.loading")}"`);
  expect(markup).not.toContain(t("requestOutcome.APPLIED"));
});

test("request_not_found offers lookup and original-request guidance without leaking any outcome", async () => {
  view.query!.data = undefined;
  view.query!.error = new ApiError(404, "request_not_found", "server fallback");
  const markup = await html();
  expect(markup).toContain(t("requestOutcome.notFound"));
  expect(markup).toContain(t("requestOutcome.remedy"));
  expect(markup).toContain('href="/requests"');
  expect(markup).not.toContain(view.id);
  expect(markup).not.toContain("server fallback");
  expect(markup).not.toContain("<button");
});

test("invalid_request_key renders its localized refusal and retry remedy without another command", async () => {
  view.query!.data = undefined;
  view.query!.error = new ApiError(422, "invalid_request_key", "server fallback");
  const markup = await html();
  expect(markup).toContain(t("requestOutcome.invalid"));
  expect(markup).toContain(t("common.retry"));
  expect(markup).toContain('role="alert"');
  expect(markup).not.toContain("server fallback");
  view.buttons.find((props) => props.children === t("common.retry"))!.onClick!({} as MouseEvent<HTMLButtonElement>);
  expect(view.refetch).toHaveBeenCalledOnce();
  expect(view.navigate).not.toHaveBeenCalled();
});

test("masked outcome explains restricted access and never serializes personal inputs or results", async () => {
  view.query!.data = outcome({ masked: true, result: null, touched: [] });
  const markup = await html();
  expect(markup).toContain(t("requestOutcome.masked"));
  expect(markup).not.toContain(`<h3>${t("requestOutcome.inputs")}</h3>`);
  expect(markup).toContain(t("requestOutcome.none"));
  expect(markup).not.toContain("private input");
  expect(markup).not.toContain(t("requestOutcome.touched"));
});

test("a refetch failure keeps the last-good receipt and its record link with an announced notice", async () => {
  view.query!.data = outcome({ result: { private_result: "private result" }, touched: [{ type: "employee", id: "person-1", audit_id: "audit-1", branch_id: null }] });
  view.query!.error = new TypeError("private network details");
  const markup = await html();
  expect(markup).toContain(t("common.loadFailed.title"));
  expect(markup).toContain(t("common.networkError"));
  expect(markup).toContain(t("requestOutcome.APPLIED"));
  expect(markup).toContain('href="/people/person-1"');
  expect(markup).toContain(t("requestOutcome.resultRecorded"));
  expect(markup).not.toContain("private network details");
  expect(markup).not.toContain("private result");
});

test.each([
  [{ go_live_at: created }, "requestOutcome.resultLive", { at: fmtDateTime(created) }],
  [{ items: [{ secret: "one" }, { secret: "two" }] }, "requestOutcome.resultItems", { count: 2 }],
] as const)("safe receipt result %j summarizes the outcome without raw payload values", async (result, message, values) => {
  view.query!.data = outcome({ result });
  expect(await html()).toContain(t(message, values));
});

test("expired receipt preserves the refusal and terminal remedy with optional deadline absent", async () => {
  view.query!.data = outcome({ state: "EXPIRED", refusal_code: "command_expired", deadline: null });
  const markup = await html();
  expect(markup).toContain(t("requestOutcome.code.command_expired"));
  expect(markup).toContain('href="/requests"');
  expect(markup).not.toContain(`<dt>${t("requestOutcome.deadline")}</dt>`);
});
