// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, assertBoundPasskeyHash, unwrap } from "@console/api";
import { read } from "../../../lib/query";

const prepareSelfBinding = (employeeId: string) =>
  unwrap(api.POST("/api/v1/users/me/employee-link/prepare", { body: { employee_id: employeeId } }));
export const selfBindingOffer = (employeeId: string) =>
  read("/api/v1/users/me/employee-link/prepare", () => prepareSelfBinding(employeeId), employeeId);

export async function bindOwnAccount(employeeId: string) {
  const binding = await prepareSelfBinding(employeeId);
  const step_up = await assertBoundPasskeyHash("EXCEPTION_DECIDE", binding.object_id, binding.payload_hash ?? "");
  return unwrap(api.POST("/api/v1/users/me/employee-link", { body: { employee_id: employeeId, step_up } }));
}
