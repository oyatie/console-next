// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

export const PEOPLE_TABS = [{ id: "roster", search: { placement: undefined } }, { id: "appointments" }, { id: "exits" }] as const;
export type PeopleTab = typeof PEOPLE_TABS[number]["id"];
export const parsePeopleTab = (value: unknown): PeopleTab => PEOPLE_TABS.find(tab => tab.id === value)?.id ?? "roster";
const EXIT_FILTERS = ["open", "closed", "REPORTED", "HR_CONFIRMED", "HQ_CONFIRMED", "SETTLEMENT_READY", "APPROVAL_DRAFTED", "SUBMITTED", "REJECTED", "CANCELLED"] as const satisfies readonly (components["schemas"]["EmployeeExitCase"]["status"] | "open" | "closed")[];
export const parseExitFilter = (value: unknown) => EXIT_FILTERS.find(status => status === value);
