import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import type { LifecycleEvent } from "../api";
import { ConvertFields } from "./lifecycle-appoint";
import { rowVerbs } from "./history-verbs";
import { EMPTY } from "./use-lifecycle-draft";

beforeAll(() => loadCatalog("ko"));

test("conversion correction shows its preserved end instead of an editable date", () => {
  const html = renderToStaticMarkup(<ConvertFields current="CONTRACT" v={{ ...EMPTY, toType: "CONTRACT", endDate: "2027-01-31" }} set={() => {}} today="2026-10-12" locked />);
  expect(html).toContain("2027-01-31");
  expect(html).toContain("이 정정에서 변경할 수 없습니다");
  expect(html).not.toContain('type="date"');
});

test("group-transfer history disables correction with its remedy and retains rescission", () => {
  const record = { id: "g", event_type: "GROUP_TRANSFER", state: "APPLIED", created_at: "2026-10-12T01:00:00Z", effective_date: "2026-10-12" } as LifecycleEvent;
  const html = renderToStaticMarkup(rowVerbs(record, { employee: {} as never, all: [record], offered: () => true, onAct: () => {} }));
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("전적은 정정할 수 없습니다");
  expect(html).toContain("철회");
});
