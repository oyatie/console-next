// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { CardHead } from "./card-head";
import { CardBar } from "./card-body";
import { SecDocs, SecRestricted } from "./sec-more";
import type { Card } from "./use-card";

const state = vi.hoisted(() => ({ served: false, failed: false, missing: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [], capabilities: state.missing ? undefined : state.served ? [{ feature: "documents", permission: "allow" }] : [] }, isError: state.failed }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span>, useNavigate: () => vi.fn(), getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }) }));
vi.mock("./use-case-actions", () => ({ useOwnRecord: () => false }));
vi.mock("./employee-warnings", () => ({ EmployeeWarnings: () => null }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.served = false; state.failed = false; state.missing = false; });
const c = { e: { id: "employee", name: "가람", status: "ACTIVE" }, d: { classification: {} }, personal: {}, events: { data: { items: [] } }, records: { data: { items: [], sections: [] } }, register: {}, place: { entity: "법인", path: [] }, title: () => undefined } as unknown as Card;

test.each([false, true])("documents tab and section follow the server capability (%s)", (served) => {
  state.served = served;
  const head = renderToStaticMarkup(<CardHead c={c} onTab={() => {}} onAct={() => {}} onGo={() => {}} onKeys={() => {}} />);
  expect(head.includes(">문서</span>")).toBe(served);
  const docs = renderToStaticMarkup(<SecDocs />);
  expect(Boolean(docs)).toBe(served);
  expect(docs).not.toContain("아직");
  const bar = renderToStaticMarkup(<CardBar c={c} current="s1" onJump={() => {}} />);
  expect(bar.includes("문서")).toBe(served);
});

test("restricted section and its navigation are absent when the server setting is off", () => {
  expect(renderToStaticMarkup(<SecRestricted c={c} />)).toBe("");
  expect(renderToStaticMarkup(<CardBar c={c} current="s1" onJump={() => {}} />)).not.toContain("제한 항목");
});

test("missing and failed capability reads do not expose the documents section", () => {
  state.missing = true;
  expect(renderToStaticMarkup(<SecDocs />)).toBe("");
  state.missing = false;
  state.served = true;
  state.failed = true;
  expect(renderToStaticMarkup(<SecDocs />)).toBe("");
});
