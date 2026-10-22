import { afterEach, expect, test, vi } from "vitest";
import { ApiError, assertBoundPasskey, assertBoundPasskeyHash } from "@console/api";
import { correctIdentifier, correctRegistrationNumber, correctionCaseQuery, correctionRegisterQuery, decideCorrection, ENTITY_READS, reviewCorrection } from "./api";

const post = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
const assertion = vi.hoisted(() => ({ assertion: { ceremony_id: "ceremony", credential: {} } }));
vi.mock("@console/api", async (original) => ({
  ...(await original<typeof import("@console/api")>()),
  api: { POST: post, GET: read },
  assertBoundPasskey: vi.fn(async () => assertion),
  assertBoundPasskeyHash: vi.fn(async () => assertion),
}));
afterEach(() => {
  post.mockReset();
  read.mockReset();
  vi.mocked(assertBoundPasskey).mockClear();
  vi.mocked(assertBoundPasskeyHash).mockClear();
});
const body = { value: "0008162529", document_id: "evidence", reason_code: "TYPO_AT_ENTRY" as const };
const send = [
  () => correctIdentifier("original", "entity", { field: "crn", ...body }),
  () => correctRegistrationNumber("original", "registration", body),
];

test.each(send)("step-up sends an authenticated intent with a fresh key after the answered refusal", async (correct) => {
  post.mockResolvedValueOnce({ response: new Response(null, { status: 428 }), error: { error: { code: "passkey_step_up_required", message: "required" } } });
  post.mockResolvedValueOnce({ response: new Response(null, { status: 200 }), data: { corrected: true } });
  await expect(correct()).resolves.toEqual({ corrected: true });
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[0]![1].params.header["Idempotency-Key"]).toBe("original");
  expect(post.mock.calls[1]![1].params.header["Idempotency-Key"]).not.toBe("original");
  expect(post.mock.calls[1]![1].body.step_up).toBe(assertion);
});

test("an ordinary refusal never asks for a passkey or resends", async () => {
  post.mockResolvedValueOnce({ response: new Response(null, { status: 409 }), error: { error: { code: "identifier_correction_needs_exception", message: "denied" } } });
  await expect(send[0]!()).rejects.toBeInstanceOf(ApiError);
  expect(post).toHaveBeenCalledTimes(1);
});


test.each(send)("a pending correction returns its recoverable receipt", async (correct) => {
  const pending = { status: "PENDING", exception_id: "exception", payload_hash: "a".repeat(64) };
  post.mockResolvedValueOnce({ response: new Response(null, { status: 202 }), data: pending });
  await expect(correct()).resolves.toEqual(pending);
  expect(post).toHaveBeenCalledTimes(1);
});

test("the correction register and case queries retain their exact subject and page", async () => {
  read.mockResolvedValue({ response: new Response(null, { status: 200 }), data: { items: [] } });
  const register = correctionRegisterQuery("entity", 40);
  expect(register.queryKey).toEqual(["/api/v1/entity-identifier-corrections", { query: { entity_id: "entity", offset: 40 } }]);
  await register.queryFn();
  expect(read).toHaveBeenLastCalledWith("/api/v1/entity-identifier-corrections", { params: { query: { entity_id: "entity", offset: 40 } } });
  await correctionCaseQuery("exception").queryFn();
  expect(read).toHaveBeenLastCalledWith("/api/v1/entity-identifier-corrections/{id}", { params: { path: { id: "exception" } } });
  expect(correctionRegisterQuery().queryKey).toEqual(["/api/v1/entity-identifier-corrections", { query: { entity_id: undefined, offset: 0 } }]);
  expect(ENTITY_READS).toContain("/api/v1/entity-identifier-corrections");
});

test.each(["APPROVE", "DECLINE"] as const)("%s decides the stored proposal with the appropriate passkey binding", async (decision) => {
  const hash = "a".repeat(64);
  post.mockResolvedValue({ response: new Response(null, { status: 200 }), data: { status: decision === "APPROVE" ? "APPROVED" : "DECLINED" } });
  await decideCorrection("exception", decision, "Reviewed the evidence", hash);
  expect(post).toHaveBeenCalledExactlyOnceWith("/api/v1/governed-exceptions/{id}/decide", {
    params: { path: { id: "exception" } },
    body: { decision, reason_code: decision === "APPROVE" ? "SECOND_PERSON_VERIFIED" : "DOCUMENT_MISMATCH", note: "Reviewed the evidence", step_up: decision === "APPROVE" ? assertion : undefined },
  });
  if (decision === "APPROVE") expect(assertBoundPasskeyHash).toHaveBeenCalledExactlyOnceWith("EXCEPTION_DECIDE", "exception", hash);
  else expect(assertBoundPasskeyHash).not.toHaveBeenCalled();
  expect(assertBoundPasskey).not.toHaveBeenCalled();
});

test("recorded corrections retain the controller's review note", async () => {
  post.mockResolvedValue({ response: new Response(null, { status: 200 }), data: { reviewed: true } });
  await expect(reviewCorrection("exception", "Checked the original")).resolves.toEqual({ reviewed: true });
  expect(post).toHaveBeenCalledExactlyOnceWith("/api/v1/entity-identifier-corrections/{id}/review", { params: { path: { id: "exception" } }, body: { note: "Checked the original" } });
});

test.each(["crn", "brn"] as const)("applying an approved %s correction sends the stored exception id", async (field) => {
  post.mockResolvedValue({ response: new Response(null, { status: 200 }), data: { corrected: true } });
  const approved = { ...body, exception_id: "approved-exception" };
  await (field === "crn" ? correctIdentifier("apply", "entity", { field, ...approved }) : correctRegistrationNumber("apply", "registration", approved));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]![1].body).toEqual({ field, ...approved, step_up: undefined });
  expect(assertBoundPasskey).not.toHaveBeenCalled();
});
