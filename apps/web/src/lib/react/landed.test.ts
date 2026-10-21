import { expect, test } from "vitest";
import { ApiError } from "@console/api";
import { LANDED, landed } from "./landed";

const record = (status: string) => () => Promise.resolve({ data: { status } });
const fail = (e: unknown) => () => Promise.reject(e);

test("a command that answers returns its result", async () => {
  expect(await landed(() => Promise.resolve("ok"), record("DRAFT"), () => false)).toBe("ok");
});

test("a lost response, a 409 or a 404 is a receipt when the record shows the change", async () => {
  expect(await landed(fail(new TypeError("network")), record("IN_APPROVAL"), (d) => d.status === "IN_APPROVAL")).toBe(LANDED);
  expect(await landed(fail(new ApiError(409, "conflict", "already")), record("IN_APPROVAL"), (d) => d.status === "IN_APPROVAL")).toBe(LANDED);
  expect(await landed(fail(new ApiError(404, "not_found", "gone")), record("REMOVED"), (d) => d.status === "REMOVED")).toBe(LANDED);
});

test("anything else is the failure it was", async () => {
  const e409 = new ApiError(409, "conflict", "someone else");
  await expect(landed(fail(e409), record("DRAFT"), (d) => d.status === "IN_APPROVAL")).rejects.toBe(e409);
  const e422 = new ApiError(422, "validation", "bad");
  await expect(landed(fail(e422), record("IN_APPROVAL"), () => true)).rejects.toBe(e422);
  const net = new TypeError("network");
  await expect(landed(fail(net), () => Promise.reject(new Error("re-read down")), () => true)).rejects.toBe(net);
});

// regression (UX-R2 SETUP, 2026-10-08): onboarding read a 409 slug_taken as a lost response and, finding a tenant of the
// same slug and name on the re-read, said 「개설되었지만 응답이 끊겨…」 for a tenant the server had refused.
test("a command whose refusals are answers (`[]`) re-reads only when no HTTP status came back", async () => {
  const taken = new ApiError(409, "slug_taken", "another tenant already uses this slug");
  await expect(landed(fail(taken), record("ACTIVE"), () => true, [])).rejects.toBe(taken);
  const gone = new ApiError(404, "not_found", "gone");
  await expect(landed(fail(gone), record("ACTIVE"), () => true, [])).rejects.toBe(gone);
  expect(await landed(fail(new TypeError("Failed to fetch")), record("ACTIVE"), (d) => d.status === "ACTIVE", [])).toBe(LANDED);
  expect(await landed(fail(new DOMException("timed out", "TimeoutError")), record("ACTIVE"), (d) => d.status === "ACTIVE", [])).toBe(LANDED);
});
