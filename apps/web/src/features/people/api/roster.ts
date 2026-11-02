// SPDX-License-Identifier: LicenseRef-Proprietary
import { settingsQuery } from "../../../reference/settings/api";
import { api, ApiError, unwrap } from "@console/api";
import type { EmployeeView } from "@console/api/pending";
import { read } from "../../../lib/query";

const viewsPath = "/api/v1/me/employee-views";
export const employeeViewsQuery = read(viewsPath, async () => {
  try { return await unwrap(api.GET(viewsPath)); }
  catch (error) {
    if (error instanceof ApiError && [404, 405].includes(error.status)) return null;
    throw error;
  }
});
export const createEmployeeView = (input: Omit<EmployeeView, "id">, key: string) => unwrap(api.POST(viewsPath, { headers: { "Idempotency-Key": key }, body: { ...input, id: key } }));

export const rosterWindowQuery = { ...settingsQuery, select: (data: Awaited<ReturnType<typeof settingsQuery.queryFn>>) => {
  const value = data.items.find(item => item.key === "hr.contract_soon_days")?.value;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error("hr.contract_soon_days");
  return value;
} };
