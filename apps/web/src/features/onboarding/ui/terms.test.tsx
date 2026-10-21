import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { ApiError } from "../api";
import { AcceptTerms } from "./terms";

const state = vi.hoisted(() => ({
  data: { version: "v1", sha256: "a".repeat(64), body: "Exact reviewed document" } as { version: string; sha256: string; body: string } | null,
  pending: false, fetching: false, readError: null as unknown, commandError: null as unknown, mutate: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => initial === false ? [true, vi.fn()] : react.useState(initial) };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.data, isPending: state.pending, isFetching: state.fetching, isError: state.readError !== null, error: state.readError, refetch: vi.fn() }) }));
vi.mock("../../../lib/react/command", async (original) => ({ ...(await original<typeof import("../../../lib/react/command")>()), useCommand: () => ({ isPending: false, error: state.commandError, mutate: state.mutate }) }));
beforeAll(() => loadCatalog("ko"));
afterEach(() => { state.data = { version: "v1", sha256: "a".repeat(64), body: "Exact reviewed document" }; state.pending = false; state.fetching = false; state.readError = null; state.commandError = null; state.mutate.mockClear(); });

const render = () => renderToStaticMarkup(<AcceptTerms />);
test("terms loading uses a skeleton without an acceptance action", () => {
  state.data = null; state.pending = true;
  const html = render();
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("고객 계정을 대표해 이용약관 동의");
});
test("failed terms read keeps the exact last document read-only and gives a retry", () => {
  state.readError = new ApiError(503, "unavailable", "unavailable");
  const html = render();
  expect(html).toContain("Exact reviewed document");
  expect(html).toMatch(/버전<\/dt><dd[^>]*>v1<\/dd>/);
  expect(html).toContain("a".repeat(64));
  expect(html).toMatch(/<button[^>]*disabled[^>]*>고객 계정을 대표해 이용약관 동의/);
  expect(html).toContain("다시 불러오기");
  expect(state.mutate).not.toHaveBeenCalled();
});
test("a terms 409 retains the document and remedy while a fresh read disarms acceptance", () => {
  state.commandError = new ApiError(409, "terms_text_changed", "changed"); state.fetching = true;
  const html = render();
  expect(html).toContain("Exact reviewed document");
  expect(html).toContain("새 내용을 읽고 동의");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>고객 계정을 대표해 이용약관 동의/);
  expect(state.mutate).not.toHaveBeenCalled();
});
