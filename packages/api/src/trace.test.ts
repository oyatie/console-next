// SPDX-License-Identifier: LicenseRef-Proprietary
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ApiError } from "./session";

test("real server envelopes preserve trace_id and support_ref outside details", () => {
  const error = ApiError.fromBody(new Response(null, { status: 500 }), {
    error: { code: "internal", message: "internal server error", trace_id: "0123456789abcdef0123456789abcdef", support_ref: "019a0000-0000-7000-8000-000000000001" },
  });
  expect(error).toMatchObject({ traceId: "0123456789abcdef0123456789abcdef", supportRef: "019a0000-0000-7000-8000-000000000001" });
  expect(error.details).toEqual({});
});

test("a response without a trace does not invent correlation", () => {
  const error = ApiError.fromBody(new Response(null, { status: 502 }), null);
  expect(error).not.toHaveProperty("traceId", expect.any(String));
  expect(error).not.toHaveProperty("supportRef", expect.any(String));
});

test("the API package contains no duplicate reference mint or dead span transport", () => {
  const path = new URL("./trace.ts", import.meta.url);
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  expect(source).not.toMatch(/client-spans|x-trace-id|createSupportReference|supportRefs/);
});
