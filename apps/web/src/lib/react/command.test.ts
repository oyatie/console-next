import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { ApiError, configure } from "@console/api";
import { COMMAND_NOT_APPLIED, keepsKey, readsAreStale, recoveryOf, useCommand } from "./command";

// Server rendering captures real hook refs; MutationObserver drives its real callbacks without a DOM dependency.
function capture(run: (input: string, key: string) => Promise<string>, verify?: (input: string, key: string) => Promise<string | typeof COMMAND_NOT_APPLIED>) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  let command!: ReturnType<typeof useCommand<string, string>>;
  function Probe({ collect }: { collect: (value: ReturnType<typeof useCommand<string, string>>) => void }) {
    collect(useCommand({ run, verify }));
    return null;
  }
  renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Probe, { collect: (value) => { command = value; } })));
  return { command, client };
}

const transportKey = "actual-transport-intent-key";
const operationId = "original-operation-id";
test("verification reads the original transport intent and settles without resending", async () => {
  const error = new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey: transportKey });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(error);
  const verify = vi.fn<(input: string, key: string) => Promise<string>>().mockResolvedValue("recorded result");
  const { command, client } = capture(run, verify);
  await expect(command.mutateAsync("original")).rejects.toBe(error);
  command.mutate("duplicate");
  command.check();
  await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)?.state).toMatchObject({ status: "success", data: "recorded result" }));
  expect(verify).toHaveBeenCalledExactlyOnceWith("original", transportKey);
  expect(run).toHaveBeenCalledTimes(1);
  client.clear();
});

test.each([new ApiError(403, "forbidden", "denied"), new Error("outcome_not_applied")])("a failed verification retains uncertainty and still refuses a new command: %s", async (failure) => {
  const error = new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey: transportKey });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(error);
  const verify = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(failure);
  const { command, client } = capture(run, verify);
  await expect(command.mutateAsync("original")).rejects.toBe(error);
  command.check();
  await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)?.state).toMatchObject({ status: "error", error }));
  await expect(command.mutateAsync("duplicate")).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
  client.clear();
});
const unanswered = [
  ["network", new TypeError("Failed to fetch")],
  ["transport network", new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey: transportKey })],
  ["5xx", new ApiError(503, "service_unavailable", "unavailable")],
  ["command_processing", new ApiError(409, "command_processing", "processing", [], operationId, true, [], { requestKey: transportKey })],
  ["command_applied", new ApiError(409, "command_applied", "applied", [], operationId, true, [], { requestKey: transportKey })],
] as const;

test.each(unanswered)("%s blocks both submit methods even after reset", async (_name, error) => {
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(error);
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBeInstanceOf(ApiError);
  const failure = client.getMutationCache().getAll()[0]!.state.error;
  expect(failure).toBeInstanceOf(ApiError);
  expect(keepsKey(failure)).toBe(true);
  command.reset();
  command.mutate("duplicate");
  await expect(command.mutateAsync("corrected")).rejects.toBe(failure);
  expect(run).toHaveBeenCalledTimes(1);
  expect(client.getMutationCache().getAll()).toHaveLength(1);
  expect(client.getMutationCache().getAll()[0]!.state.status).toBe("error");
  client.clear();
});

test("actual transport key wins over the hook key and keeps the original operation id", async () => {
  const error = new ApiError(503, "service_unavailable", "unavailable", [], operationId, true, [], { requestKey: transportKey });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(error);
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBe(error);
  const hookKey = run.mock.calls[0]![1];
  expect(hookKey).not.toBe(transportKey);
  expect(client.getMutationCache().getAll()[0]!.state.error).toMatchObject({ requestKey: transportKey, operationId });
  client.clear();
});

test("a generic network failure carries the hook's original key for outcome lookup", async () => {
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(new TypeError("Failed to fetch"));
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toMatchObject({ status: 0, code: "command_unknown" });
  expect(client.getMutationCache().getAll()[0]!.state.error).toMatchObject({ requestKey: run.mock.calls[0]![1] });
  client.clear();
});

const refusals = [
  ["422", new ApiError(422, "validation", "bad")],
  ["invalid_request_key", new ApiError(422, "invalid_request_key", "invalid")],
  ["request_not_found", new ApiError(404, "request_not_found", "not found")],
  ["idempotency_key_reused", new ApiError(409, "idempotency_key_reused", "changed inputs")],
  ["command_settled", new ApiError(409, "command_settled", "terminal")],
  ["command_expired", new ApiError(409, "command_expired", "expired")],
  ["503 import_apply_busy (shed before writing)", new ApiError(503, "import_apply_busy", "busy")],
  ["local preview Refused", new Error("preview_has_refusals")],
  ["passkey DOMException", new DOMException("prompt cancelled", "NotAllowedError")],
] as const;

test.each(refusals)("%s permits a corrected intent with a new key", async (_name, error) => {
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("corrected result");
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBe(error);
  expect(keepsKey(error)).toBe(false);
  command.reset();
  expect(run).toHaveBeenCalledTimes(1);
  await expect(command.mutateAsync("corrected")).resolves.toBe("corrected result");
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]![0]).toBe("corrected");
  expect(run.mock.calls[1]![1]).not.toBe(run.mock.calls[0]![1]);
  client.clear();
});

test("ordinary refusal also leaves the void mutate method available", async () => {
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValueOnce(new ApiError(422, "validation", "bad")).mockResolvedValue("corrected");
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBeInstanceOf(ApiError);
  command.mutate("corrected");
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]![1]).not.toBe(run.mock.calls[0]![1]);
  client.clear();
});

test("an answered 4xx resets the key; network faults and 5xx keep it", () => {
  for (const status of [400, 409, 422]) expect(keepsKey(new ApiError(status, "refusal", "bad"))).toBe(false);
  for (const status of [500, 503]) expect(keepsKey(new ApiError(status, "unavailable", "bad"))).toBe(true);
  for (const code of ["import_apply_busy", "import_run_expired"]) expect(keepsKey(new ApiError(503, code, "refused before writing"))).toBe(false);
  expect(keepsKey(new TypeError("Failed to fetch"))).toBe(true);
});

test("409 refreshes stale reads; other failures do not", () => {
  expect(readsAreStale(new ApiError(409, "stale_revision", "newer revision"))).toBe(true);
  expect(readsAreStale(new ApiError(422, "validation", "bad"))).toBe(false);
  expect(readsAreStale(new ApiError(500, "internal", "bad"))).toBe(false);
  expect(readsAreStale(new TypeError("Failed to fetch"))).toBe(false);
});

test.each(["APPLIED", "PROCESSING", "missing"])("explicit recovery of %s checks first and replays only the original input and key", async (state) => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValue("original result");
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBeInstanceOf(ApiError);
  const key = run.mock.calls[0]![1];
  const fetch = vi.fn(async (request: Request) => {
    expect(request.url).toBe(`https://console.example/api/v1/requests/${key}`);
    expect(run).toHaveBeenCalledTimes(1);
    return new Response(JSON.stringify(state === "missing" ? { error: { code: "request_not_found", message: "missing" } } : { state, masked: false }), { status: state === "missing" ? 404 : 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    command.check();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]).toEqual(["original", key]);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    client.clear();
    vi.unstubAllGlobals();
  }
});

test.each([{ state: "APPLIED", masked: true }, { state: "REFUSED", masked: false }])("recovery cannot replay a masked or terminal outcome: %j", async (outcome) => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(new TypeError("lost"));
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBeInstanceOf(ApiError);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(outcome), { headers: { "content-type": "application/json" } }));
  try {
    command.check();
    await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)!.state.error).toMatchObject({ code: "command_settled" }));
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    client.clear();
    vi.unstubAllGlobals();
  }
});

test.each([false, true])("a refused recovery read keeps the original command locked (custom reader: %s)", async (custom) => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValue("original result");
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBeInstanceOf(ApiError);
  const original = client.getMutationCache().getAll()[0]!.state.error;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "forbidden", message: "denied" } }), { status: 403, headers: { "content-type": "application/json" } }));
  try {
    command.check(custom ? async () => { throw new ApiError(403, "forbidden", "denied"); } : undefined);
    await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)!.state.status).toBe("error"));
    expect(client.getMutationCache().getAll().at(-1)!.state.error).toBe(original);
    await expect(command.mutateAsync("changed")).rejects.toBe(original);
    expect(run).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ state: "APPLIED", masked: false }), { headers: { "content-type": "application/json" } }));
    command.check(custom ? async () => "verified" : undefined);
    await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)!.state.status).toBe("success"));
    expect(run).toHaveBeenCalledTimes(custom ? 1 : 2);
    await expect(command.mutateAsync("next")).resolves.toBe("original result");
    expect(run.mock.calls.at(-1)![1]).not.toBe(run.mock.calls[0]![1]);
  } finally {
    client.clear();
    vi.unstubAllGlobals();
  }
});

test("concurrent gateway retry presses re-send the original intent only once", async () => {
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValueOnce(new ApiError(502, "http_502", "Bad Gateway", [], undefined, false)).mockResolvedValue("registered");
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBeInstanceOf(ApiError);
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "request_not_found", message: "missing" } }), { status: 404, headers: { "content-type": "application/json" } }));
  command.check();
  command.check();
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]![1]).toBe(run.mock.calls[0]![1]);
  vi.unstubAllGlobals();
  client.clear();
});

test.each([[403, "forbidden"], [500, "request_not_found"], [404, "not_found"]])("recovery stays locked after lookup %s/%s", async (status, code) => {
  configure({ baseUrl: "https://console.example", passkeys: { get: async () => null, create: async () => null }, refresh: { kind: "cookie" } });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValueOnce(new TypeError("lost")).mockResolvedValue("original result");
  const { command, client } = capture(run);
  await expect(command.mutateAsync("original")).rejects.toBeInstanceOf(ApiError);
  const failure = client.getMutationCache().getAll()[0]!.state.error;
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code, message: "lookup failed" } }), { status: Number(status), headers: { "content-type": "application/json" } }));
  try {
    command.check();
    await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)!.state.status).toBe("error"));
    expect(client.getMutationCache().getAll().at(-1)!.state.error).toBe(failure);
    await expect(command.mutateAsync("changed")).rejects.toBe(failure);
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    client.clear();
    vi.unstubAllGlobals();
  }
});

// Regression (CL-dev-reds, chaos-setup): an uncertain save left screens without an in-place check locked behind a
// disabled button. Each uncertain failure now carries its command's recovery for the shared refusal to offer.
test("an uncertain failure carries its command's recovery; an answered refusal carries none", async () => {
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(new TypeError("Failed to fetch"));
  const verify = vi.fn<(input: string, key: string) => Promise<string>>().mockResolvedValue("recorded result");
  const { command, client } = capture(run, verify);
  const failure: unknown = await command.mutateAsync("original").catch((e: unknown) => e);
  expect(failure).toMatchObject({ status: 0, code: "command_unknown" });
  const finish = recoveryOf(failure);
  expect(finish).toBeTypeOf("function");
  finish!();
  await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)?.state).toMatchObject({ status: "success", data: "recorded result" }));
  expect(verify).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
  const refused = new ApiError(422, "validation", "bad");
  const second = capture(vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValue(refused));
  await expect(second.command.mutateAsync("x")).rejects.toBe(refused);
  expect(recoveryOf(refused)).toBeUndefined();
  client.clear();
  second.client.clear();
});

test("an authoritative non-application replays the original input and key, never a new intent", async () => {
  const error = new ApiError(0, "command_unknown", "", [], undefined, false, [], { requestKey: transportKey });
  const run = vi.fn<(input: string, key: string) => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("recorded");
  const verify = vi.fn<() => Promise<typeof COMMAND_NOT_APPLIED>>(async () => COMMAND_NOT_APPLIED);
  const { command, client } = capture(run, verify);
  await expect(command.mutateAsync("original")).rejects.toBe(error);
  command.mutate("different");
  command.check();
  await vi.waitFor(() => expect(client.getMutationCache().getAll().at(-1)?.state).toMatchObject({ status: "success", data: "recorded" }));
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
  expect(run.mock.calls[1]?.[0]).toBe("original");
  client.clear();
});
