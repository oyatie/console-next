// SPDX-License-Identifier: LicenseRef-Proprietary
import { id } from "../mock/fixtures";

export const lifecycleSheetScreens = [
  { key: "lifecycle-sheet", path: `/people/${id(4000)}?act=TRANSFER`, read: "/api/v1/employees/{id}", states: { populated: "Move a workplace-direct employee within or across workplaces in one sheet." }, registry: "people-id-act-verb--transfer-scheduled", live: "e2e/j2-transfer.spec.ts" },
  { key: "lifecycle-menu", path: `/people/${id(4000)}?act=menu`, read: "/api/v1/employees/{id}", states: { populated: "The server refuses transfers for an employee on leave; each menu item names its act." }, registry: "people-id-act-menu--disabled-items-with-why", live: "e2e/lifecycle-sheets.spec.ts" },
] as const;
