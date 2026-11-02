// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import type { APIResponse } from "@playwright/test";
import { codeOf } from "../helpers/api";

function probePath(operation: string, ids: Record<string, string>) {
  const path = operation.split(" ")[1];
  if (!path?.startsWith("/")) return null;
  return path.replace(/\{[^}]+\}/g, (_parameter, offset: number) => {
    const collection = path.slice(0, offset).split("/").filter(Boolean).at(-1)!;
    return ids[collection] ?? randomUUID();
  });
}

type Response = Pick<APIResponse, "status" | "ok" | "json" | "dispose">;
type Send = (path: string, method: string) => Promise<Response>;
type WriteResult = Awaited<ReturnType<typeof attemptWrite>>;

export function classifyWrite(result: WriteResult, control: WriteResult, selfServiceReason?: string) {
  const http = result.http_status;
  const controlValid = (control.http_status >= 200 && control.http_status < 300 || control.http_status >= 400 && control.http_status < 500)
    && ![401, 403].includes(control.http_status);
  let status: "pass" | "fail" | "unknown" = "unknown", fault: string | null = null;
  if (selfServiceReason) {
    if (http === 403) fault = `remove self-service exception (${result.code})`;
  } else if (http === 401) {
    fault = "unauthenticated probe";
  } else if (http >= 200 && http < 300) {
    status = "fail";
    fault = "accepted without a grant";
  } else if (http === 403 && result.code?.trim() && controlValid) {
    status = "pass";
  }
  return { status, controlValid, fault };
}

export async function* probeWrites(operations: string[], ids: Record<string, string>, noGrant: Send, ops: Send) {
  const measured = [];
  // Finish the no-grant sweep before an ops DELETE can remove another probe's fixture.
  for (const operation of operations) {
    const method = operation.split(" ")[0]!, path = probePath(operation, ids);
    measured.push({ operation, path, method, result: await attemptWrite(noGrant, path, method) });
  }
  for (const row of measured) yield { ...row, control: await attemptWrite(ops, row.path, row.method) };
}

async function attemptWrite(send: Send, path: string | null, method: string) {
  if (!path) return { http_status: 0, code: null, support_ref: null, error: "unresolved route" };
  try {
    const response = await send(path, method);
    try {
      const code = await codeOf(response);
      const body = await response.json().catch(() => null) as { error?: { support_ref?: string } } | null;
      return { http_status: response.status(), code, support_ref: body?.error?.support_ref ?? null };
    } finally {
      await response.dispose();
    }
  } catch {
    // Request exceptions can contain Authorization headers; artifacts retain only the fault class.
    return { http_status: 0, code: null, support_ref: null, error: "request failed" };
  }
}
