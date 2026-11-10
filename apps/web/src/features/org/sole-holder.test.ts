// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { decideSoleHolder } from "./api/sole-holder";

const { post, passkey } = vi.hoisted(() => ({ post: vi.fn(), passkey: vi.fn() }));
vi.mock("@console/api", async original => ({
  ...await original<typeof import("@console/api")>(), api: { POST: post }, assertBoundPasskeyHash: passkey,
}));
afterEach(() => { vi.resetAllMocks(); });
const offer = { step_id: "step", expected_version: "17", payload_hash: "a".repeat(64), notice_count: 2, review_due_at: "2026-11-09T03:00:00Z" };
const reply = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });

test("the solo decision signs the server fingerprint and preserves its version and step", async () => {
  const envelope = { assertion: "verified" };
  const receipt = { sole_holder_exception: { id: "exception", notice_count: 2, review_due_at: offer.review_due_at } };
  passkey.mockResolvedValue(envelope);
  post.mockResolvedValue(reply(receipt));
  expect(await decideSoleHolder("change", offer, "intent")).toEqual(receipt);
  expect(passkey).toHaveBeenCalledWith("EXCEPTION_DECIDE", "change", offer.payload_hash);
  expect(post).toHaveBeenCalledWith("/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", {
    headers: { "Idempotency-Key": "intent" }, params: { path: { id: "change", stepId: "step" } }, body: { decision: "APPROVED", expected_version: "17", step_up: envelope },
  });
});

test("a cancelled passkey cannot send a decision", async () => {
  passkey.mockRejectedValue(new Error("passkey_cancelled"));
  await expect(decideSoleHolder("change", offer, "intent")).rejects.toThrow("passkey_cancelled");
  expect(post).not.toHaveBeenCalled();
});

test("a successful response without an exception cannot claim a solo approval", async () => {
  passkey.mockResolvedValue({});
  post.mockResolvedValue(reply({ status: "APPROVED" }));
  await expect(decideSoleHolder("change", offer, "intent")).rejects.toMatchObject({ code: "command_unknown" });
  expect(post).toHaveBeenCalledTimes(1);
});
