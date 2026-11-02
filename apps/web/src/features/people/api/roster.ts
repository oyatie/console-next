// SPDX-License-Identifier: LicenseRef-Proprietary
import { settingsQuery } from "../../../reference/settings/api";
import { api, unwrap } from "@console/api";
import type { EmployeeView } from "@console/api/pending";
import { get } from "../../../lib/query";

const viewsPath = "/api/v1/me/employee-views";
export const employeeViewsQuery = get(viewsPath);
export const createEmployeeView = (input: Omit<EmployeeView, "id">, key: string) => unwrap(api.POST(viewsPath, { headers: { "Idempotency-Key": key }, body: { ...input, id: key } }));

export const rosterWindowQuery = { ...settingsQuery, select: (data: Awaited<ReturnType<typeof settingsQuery.queryFn>>) => {
  const value = data.items.find(item => item.key === "hr.contract_soon_days")?.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error("hr.contract_soon_days");
  return value;
} };
