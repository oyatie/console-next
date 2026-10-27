// SPDX-License-Identifier: LicenseRef-Proprietary
import { id } from "../mock/fixtures";

// Slice 1 covers the case board; list states follow with the list slice.
export const peopleExitScreens = [{
  key: "exit-case", path: `/people/exits/${id(7000)}`, read: "/api/v1/hr/exit-cases/{id}",
  states: {
    reported: "Reported case with an open trail.", "hr-confirmed": "HR-confirmed scheduled exit.",
    dismissal: "Dismissal with an overdue notice item.", "settlement-unavailable": "Settlement with missing source figures.",
    closed: "Closed trail retains every item.", missing: "Contract 404 envelope.", failed: "Contract 503 envelope.",
  },
  registry: "people-exits-id--exit-case-1", live: "e2e/lifecycle-trail.spec.ts",
}] as const;
export type ExitCaseState = keyof typeof peopleExitScreens[number]["states"];
