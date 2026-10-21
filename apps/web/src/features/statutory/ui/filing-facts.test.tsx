// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { FilingTask } from "../../../reference/statutory/api";
import { filingLabel } from "../present";
import { FilingFactsFields } from "./filing-facts";

beforeAll(() => loadCatalog("ko"));

function makeTask(overrides: Partial<FilingTask> = {}): FilingTask {
  return {
    event_id: "evt-1",
    employee_id: "emp-1",
    name: "홍길동",
    employee_number: "E-1",
    kind: "ACQUIRE",
    insurer: "NPS",
    effective_date: "2026-10-01",
    legal_entity_id: null,
    workplace_id: null,
    workplace_name: null,
    due_date: null,
    due_in_days: null,
    deadline_status: "OK",
    version: 1,
    completed_on: null,
    receipt_number: null,
    loss_code: null,
    detail: null,
    opens_on: null,
    target_on: null,
    due_on: null,
    dates: null,
    basis: {
      code: "B1",
      citation: { instrument: "", article: "", promulgation: "", source_url: "", enforced_on: "" },
      applicability_citations: [],
      remuneration_required: false,
      exclusions: [],
      covered_by: null,
      penalty: null,
    },
    applicability: { status: "APPLIES" },
    applicability_facts: {},
    can_record_sensitive_facts: true,
    birth_date_known: true,
    state: "PENDING",
    record_action: null,
    not_applicable_reason: null,
    not_applicable_options: [],
    total_remuneration_won: null,
    is_request: false,
    acquired_on: null,
    loss_options: [],
    ...overrides,
  } as FilingTask;
}

const countLabel = (html: string, key: string) => html.split(filingLabel(key)).length - 1;

test("renders multiple_jobs_covered once when INCOME and pension_exceptions both apply", () => {
  const task = makeTask({
    basis: {
      ...makeTask().basis!,
      exclusions: [{ type: "INCOME" }, { type: "SHORT_HOURS", pension_exceptions: true }],
    },
  });
  const html = renderToStaticMarkup(<FilingFactsFields task={task} facts={{}} onChange={() => {}} />);
  expect(countLabel(html, "multiple_jobs_covered")).toBe(1);
});

test("renders work_days once outside details when WORK_CONFIRMATION and days_exception both apply", () => {
  const task = makeTask({
    kind: "WORK_CONFIRMATION",
    basis: {
      ...makeTask().basis!,
      exclusions: [{ type: "DAILY", days_exception: 8 }],
    },
  });
  const html = renderToStaticMarkup(<FilingFactsFields task={task} facts={{}} onChange={() => {}} />);
  expect(countLabel(html, "work_days")).toBe(1);
  const [beforeDetails, inDetails] = html.split("<details");
  expect(beforeDetails).toContain(filingLabel("work_days"));
  expect(inDetails).not.toContain(filingLabel("work_days"));
});

test("opens additional-facts details when applicability status is UNKNOWN", () => {
  const html = renderToStaticMarkup(
    <FilingFactsFields task={makeTask({ applicability: { status: "UNKNOWN", missing: [] } })} facts={{}} onChange={() => {}} />,
  );
  expect(html).toContain("<details open");
});

test("opens additional-facts details when applicability lists a missing fact", () => {
  const html = renderToStaticMarkup(
    <FilingFactsFields
      task={makeTask({ applicability: { status: "APPLIES", missing: ["worked_monthly_hours"] } as unknown as FilingTask["applicability"] })}
      facts={{}}
      onChange={() => {}}
    />,
  );
  expect(html).toContain("<details open");
});

test("opens additional-facts details when error is true", () => {
  const html = renderToStaticMarkup(<FilingFactsFields task={makeTask()} facts={{}} onChange={() => {}} error />);
  expect(html).toContain("<details open");
});

test("keeps additional-facts details closed when applicability is known with nothing missing and no error", () => {
  const html = renderToStaticMarkup(<FilingFactsFields task={makeTask()} facts={{}} onChange={() => {}} />);
  expect(html).toContain("<details><summary>");
  expect(html).not.toContain("<details open");
});
