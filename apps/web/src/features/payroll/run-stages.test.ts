// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { runStages } from "./present";
import type { PayrollRun } from "./api";

const stages = { STAGED: 0, BLOCKED_LEGAL_GATE: 0, READY_FOR_REVIEW: 0, ATTENDANCE_CLOSED: 1, CALCULATING: 1, CALCULATED: 2, SUBMITTED: 3, REJECTED: 2, APPROVED: 4, DISBURSEMENT_SCHEDULED: 4, PAID: 5, ISSUED: 6, VOID: -1 } as const satisfies Record<PayrollRun["status"], number>;
for (const [status, current] of Object.entries(stages)) test(`${status} reflects stored progress on a read-only six-stage rail`, () => {
  const steps = runStages(status as PayrollRun["status"]);
  expect(steps.map(step => step.key)).toEqual(["attendance", "calculate", "exceptions", "approval", "payment", "delivery"]);
  expect(steps.map(step => step.state)).toEqual(Array.from({ length: 6 }, (_, n) => n === current ? "current" : n < current ? "done" : "waiting"));
});
