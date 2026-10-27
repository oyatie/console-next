// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { verbStates, type VerbState } from "../domain/lifecycle";
import { LifecycleMenu } from "./lifecycle-menu";

const access = vi.hoisted(() => ({ exit: false }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => access.exit }));

type Detail = components["schemas"]["EmployeeDetail"];
const detail = (status = "ACTIVE") => ({
  employee: { id: "person-menu", name: "정하늘", status },
  employment: { employment_type: "REGULAR" },
  allowed_events: [],
  allowed_scheduled_events: [],
  schedule_after: null,
}) as unknown as Detail;
const render = (verbs: readonly VerbState[], d = detail()) => renderToStaticMarkup(<LifecycleMenu d={d} verbs={verbs} setup={false} onOpen={() => {}} onClose={() => {}} />);

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { access.exit = false; });

test("a regular employee has no irrelevant renewal or unserved personnel acts", () => {
  const d = detail();
  const html = render(verbStates(d, []), d);
  for (const text of ["계약 갱신", "전출", "파견", "대기발령", "직위해제", "정직", "근무형태", "등록 취소", "아직"]) expect(html).not.toContain(text);
});

test("only supplied verb groups appear and refused exit controls are absent", () => {
  const html = render([{ verb: "APPOINT", enabled: true }]);
  expect(html).toContain("직책 임면");
  expect(html).toContain("직무 · 직군");
  expect(html.match(/<section/g)).toHaveLength(1);
  expect(html).not.toContain("exit.report-d");
  expect(render([])).not.toContain("<button");
  access.exit = true;
  expect(render([])).toContain("exit.report-d");
  expect(render([], detail("EXITED"))).not.toContain("exit.report-d");
});

test("an applicable refused verb keeps its server-fact reason", () => {
  const html = render([{ verb: "TRANSFER", enabled: false, why: { kind: "onLeave" } }], detail("ON_LEAVE"));
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("휴직 중에는 할 수 없습니다.");
  expect(html).not.toContain("아직");
  expect(html).not.toContain("RETURN_FROM_LEAVE-d");
});

test("the relocation refusal names relocation while using the transfer's server state", () => {
  const html = render([{ verb: "TRANSFER", enabled: false, why: { kind: "onLeave" } }], detail("ON_LEAVE"));
  expect(html).toContain("전근은 휴직 중에는 할 수 없습니다.");
  expect(html).toContain("전보는 휴직 중에는 할 수 없습니다.");
});

test("a verb without a concrete server-fact refusal is absent", () => {
  expect(render([{ verb: "CONTRACT_RENEWAL", enabled: false, why: { kind: "generic" } }])).not.toContain("계약 갱신");
});

test("a job action reaches its dedicated route unchanged", () => {
  const onOpen = vi.fn();
  const grid = LifecycleMenu({ d: detail(), verbs: [{ verb: "APPOINT", enabled: true }], setup: false, onOpen, onClose: () => {} });
  grid.props.onPick("APPOINT:job");
  expect(onOpen).toHaveBeenCalledWith("APPOINT:job");
});
