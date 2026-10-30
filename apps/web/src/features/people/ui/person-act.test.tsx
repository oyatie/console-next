// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { ComponentProps } from "react";
import { ActHost } from "./person-act";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isSuccess: true, isLoading: false, data: { items: [] } }) }));
beforeAll(() => loadCatalog("ko"));
type Props = ComponentProps<typeof ActHost>;
const event = { id: "event", event_type: "TRANSFER", state: "APPLIED", created_at: "2026-10-20T00:00:00Z" };
const detail = { employee: { id: "person", name: "김직원", status: "ACTIVE", updated_at: "version" }, employment: { employment_type: "REGULAR" }, allowed_events: [{ event_type: "TRANSFER", required_signoffs: [] }], allowed_scheduled_events: [] } as unknown as Props["d"];

test.each(["again:event", "cancel:event", "edit:event", "correct:missing", "rescind:missing", "PROMOTE"])("%s always explains the unavailable action", act => {
  const markup = renderToStaticMarkup(<ActHost d={detail} act={act} events={{ data: { items: [event], head_version: 1 }, isFetching: false } as unknown as Props["events"]} onClose={() => {}} onOpen={() => {}} onRecorded={() => {}} />);
  expect(markup).toContain(t("person.act.unavailable"));
  expect(markup).not.toContain("<code");
  expect(markup).toContain(act.endsWith(":missing") ? "기록을 찾을 수 없습니다" : "상태");
});

test("fallback wording uses the personnel history glossary", () => {
  expect(t("person.act.unavailable.state")).toContain("인사 이력");
  expect(t("person.act.unavailable.state")).not.toContain("발령 이력");
});


test.each(["correct", "rescind"])("%s displays an unfamiliar server refusal code with a catalog fallback", verb => {
  const items = [{ ...event, action_refusals: { [verb]: "lifecycle_rule_changed" } }];
  const markup = renderToStaticMarkup(<ActHost d={detail} act={`${verb}:event`} events={{ data: { items, head_version: 1 }, isFetching: false } as unknown as Props["events"]} onClose={() => {}} onOpen={() => {}} onRecorded={() => {}} />);
  expect(markup).toContain("lifecycle_rule_changed");
  expect(markup).toContain(t("person.act.unavailable.state"));
});

test.each([
  ["SCHEDULED", "TRANSFER", undefined, "lifecycle_void_not_applied"],
  ["APPLIED", "TERMINATE", undefined, "lifecycle_void_exit_owned"],
  ["APPLIED", "ONBOARD", undefined, "lifecycle_void_unsupported"],
  ["APPLIED", "GROUP_TRANSFER", undefined, "lifecycle_void_unsupported"],
  ["APPLIED", "TRANSFER", "replacement", "lifecycle_event_voided"],
  ["APPLIED", "TRANSFER", undefined, "lifecycle_void_not_latest"],
])("%s %s uses its catalog refusal %s %s", (state, event_type, voided_by, code) => {
  const events = [
    { ...event, state, event_type, voided_by, action_refusals: { correct: code } },
    ...(event_type === "GROUP_TRANSFER" ? [] : [{ ...event, id: "later", created_at: "2026-10-21T00:00:00Z" }]),
  ];
  const markup = renderToStaticMarkup(<ActHost d={detail} act="correct:event" events={{ data: { items: events, head_version: 1 }, isFetching: false } as unknown as Props["events"]} onClose={() => {}} onOpen={() => {}} onRecorded={() => {}} />);
  expect(markup).toContain(code);
  expect(markup).toContain(t(`person.act.unavailable.${code}` as Parameters<typeof t>[0]));
});

test("the server owns correction refusal codes, even when local state suggests another rule", () => {
  const items = [{ ...event, state: "SCHEDULED", action_refusals: { correct: "lifecycle_void_exit_owned" } }];
  const markup = renderToStaticMarkup(<ActHost d={detail} act="correct:event" events={{ data: { items, head_version: 1 }, isFetching: false } as unknown as Props["events"]} onClose={() => {}} onOpen={() => {}} onRecorded={() => {}} />);
  expect(markup).toContain("lifecycle_void_exit_owned");
  expect(markup).not.toContain("lifecycle_void_not_applied");
});

test("an older event response explains unavailability without making up a server refusal code", () => {
  const items = [{ ...event, state: "SCHEDULED" }];
  const markup = renderToStaticMarkup(<ActHost d={detail} act="correct:event" events={{ data: { items, head_version: 1 }, isFetching: false } as unknown as Props["events"]} onClose={() => {}} onOpen={() => {}} onRecorded={() => {}} />);
  expect(markup).toContain(t("person.act.unavailable.state"));
  expect(markup).not.toContain("<code");
});
