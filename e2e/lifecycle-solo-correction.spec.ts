// SPDX-License-Identifier: LicenseRef-Proprietary
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { kstDate, registerEmployee } from "./flows";
import { apiOf, bearerOf, codeOf } from "./helpers/api";
import { openTenant } from "./helpers/tenant";
import { hrAct } from "./record";
import { setupCompany, startOperations } from "./setup-flows";
import { reasonBox, sheet, todayPreset } from "./sheet";

// Create the tenant, employee and original event through the product. The new correction
// contract is exercised directly because the personnel screen belongs to another active lane.
test("a sole recorder corrects a lifecycle date only with its bound passkey", { tag: ["@hr", "@regression", "@negative"] }, async ({ browser }) => {
  const admin = await openTenant(browser, "solocorrection", "정정상사");
  const api = apiOf(admin, bearerOf(admin));
  await setupCompany(admin, "정정상사", "본사");
  await startOperations(admin);
  await registerEmployee(admin, { name: "정정인", number: "SC-0001", hired: kstDate(-100), unit: "본사" });
  const employee = new URL(admin.url()).pathname.split("/").pop()!;
  await hrAct(admin, "휴직 처리");
  const leave = sheet(admin, "정정인 휴직 처리");
  await leave.getByText("개인 사유", { exact: true }).click();
  await todayPreset(leave).click();
  await reasonBox(leave).fill("개인 사정");
  const recorded = admin.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/employees/${employee}/lifecycle-events`);
  await leave.getByRole("button", { name: "오늘 휴직 처리", exact: true }).click();
  const original = await (await recorded).json() as { id: string; effective_date: string };
  await expect(leave).toBeHidden();
  // Keys are recursively sorted, exactly as the published signing contract requires.
  const replacement = { comment: "복직 예정일 정정", effective_date: original.effective_date, event_type: "LEAVE_OF_ABSENCE", expected_return_date: kstDate(30), leave_type: "PERSONAL" };
  const body = { replacement, reason_code: "INPUT_ERROR" };
  const path = `/employees/${employee}/lifecycle-events/${original.id}/correct`;
  const refused = await api(path, "POST", body);
  expect(refused.status()).toBe(401);
  expect(await codeOf(refused)).toBe("step_up_required");
  const payload = JSON.stringify({ employee_id: employee, note: null, operation: "employee.lifecycle.correct", reason_code: body.reason_code, replacement });
  const binding = { action_kind: "EXCEPTION_DECIDE", object_id: original.id, reason_key: "passkey_step_up_exception_decide", replay_attempt: null, payload_hash: createHash("sha256").update(payload).digest("hex") };
  const startResponse = await api("/auth/passkey/step-up/start", "POST", { binding });
  expect(startResponse.ok()).toBeTruthy();
  const start = await startResponse.json() as { ceremony_id: string; challenge: { publicKey: PublicKeyCredentialRequestOptionsJSON } };
  const credential = await admin.evaluate(async (options) => {
    const assertion = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) }) as PublicKeyCredential | null;
    return assertion?.toJSON();
  }, start.challenge.publicKey);
  expect(credential).toBeTruthy();
  const step_up = { binding, assertion: { ceremony_id: start.ceremony_id, credential } };
  const mismatch = await api(path, "POST", { ...body, replacement: { ...replacement, expected_return_date: kstDate(31) }, step_up });
  expect(mismatch.status()).toBe(401);
  expect(await codeOf(mismatch)).toBe("step_up_failed");
  const corrected = await api(path, "POST", { ...body, step_up });
  expect(corrected.status()).toBe(200);
  const fixed = await corrected.json() as { id: string; voids_event_id: string; expected_return_date: string };
  expect(fixed.voids_event_id).toBe(original.id);
  expect(fixed.expected_return_date).toBe(replacement.expected_return_date);
  const historyResponse = await api(`/employees/${employee}/lifecycle-events`);
  expect(historyResponse.ok()).toBeTruthy();
  const history = await historyResponse.json() as { items: { id: string; voided_by: string | null }[] };
  expect(history.items.find((event) => event.id === original.id)?.voided_by).toBe(fixed.id);
});
