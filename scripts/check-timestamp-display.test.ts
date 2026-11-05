// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, it } from "vitest";
import { checkTimestampDisplay, timestampDisplayProblems } from "./check-timestamp-display.mjs";

describe("timestamp wire format guard", () => {
  it.each([
    'json!({"checked_at":checked_at.to_string()})',
    'csv_field(&item.occurred_at.to_string())',
    'json!({"completed_at": self.completed_at.map(|value| value.to_string())})',
    'json!({"next_run_at": next_run_at.map(|at| at.to_string())})',
    'item.created_at\n .to_string()',
    'json!({"next_run_at": next_run_at.map(|at| { at.to_string() })})',
    'format!("{}", item.created_at)',
    'format!("{created_at}")',
    'json!({"created_at": format!("{value}")})',
    'json!({"created_at": value.to_string()})',
  ])("rejects Display conversion: %s", source => {
    expect(timestampDisplayProblems("backend/crates/example/rest/src/lib.rs", source)).toHaveLength(1);
  });
  it.each([
    'id.to_string()',
    'work_date.to_string()',
    'json!({"completed_by": self.completed_by.map(|value| value.to_string())})',
    'rfc3339(item.created_at)?',
    '#[serde(with = "time::serde::rfc3339")] created_at: OffsetDateTime',
  ])("allows non-timestamps and RFC 3339: %s", source => {
    expect(timestampDisplayProblems("backend/app/src/example.rs", source)).toEqual([]);
  });
});

it("production timestamp conversions use RFC 3339", () => {
  expect(checkTimestampDisplay()).toEqual([]);
});
