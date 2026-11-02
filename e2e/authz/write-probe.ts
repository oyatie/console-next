// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import type { APIResponse } from "@playwright/test";
import { codeOf } from "../helpers/api";

export function probePath(operation: string, ids: Record<string, string>) {
  const path = operation.split(" ")[1];
  if (!path?.startsWith("/")) return null;
  return path.replace(/\{[^}]+\}/g, (_parameter, offset: number) => {
    const collection = path.slice(0, offset).split("/").filter(Boolean).at(-1)!;
    return ids[collection] ?? randomUUID();
  });
}

type Response = Pick<APIResponse, "status" | "ok" | "json" | "dispose">;
export async function attemptWrite(send: (path: string, method: string) => Promise<Response>, path: string | null, method: string) {
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
