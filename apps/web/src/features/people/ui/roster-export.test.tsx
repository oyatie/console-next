// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { RosterExport } from "./roster-export";

const state = vi.hoisted(() => ({ cursor: 0, layout: null as string | null, submit: undefined as undefined | (() => void), navigate: vi.fn(), mutate: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const n = state.cursor++;
  return [n === 0 ? true : n === 1 ? state.layout : initial, vi.fn()];
} }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ mutate: state.mutate, reset: vi.fn(), isPending: false }) }));
vi.mock("../../../ui/dialog", () => ({ Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../../../ui/button/button", async original => ({ ...await original<typeof import("../../../ui/button/button")>(), Form: ({ children, onSubmit }: { children: ReactNode; onSubmit: () => void }) => { state.submit = onSubmit; return <div>{children}</div>; } }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.cursor = 0; state.layout = null; state.navigate.mockClear(); state.mutate.mockClear(); });
const render = () => renderToStaticMarkup(<RosterExport query={{}} total={2} />);

test("one export entry offers directory and statutory register formats", () => {
  const html = render();
  expect(html).toContain("직원 명부");
  expect(html).toContain("근로자 명부");
  state.submit!();
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.navigate).not.toHaveBeenCalled();
});
test("the register format opens the existing register export without downloading directory rows", () => {
  state.layout = "register";
  const html = render();
  expect(html).not.toContain("내려받는 용도");
  state.submit!();
  expect(state.mutate).not.toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/people" }));
  const search = state.navigate.mock.calls[0]![0].search;
  expect(search({ find: "김" })).toEqual({ find: "김", export: "register" });
});
test("directory export retains the purpose refusal until a purpose is chosen", () => {
  state.layout = "directory";
  expect(render()).toContain("내려받는 용도");
  state.submit!();
  expect(state.mutate).not.toHaveBeenCalled();
});
