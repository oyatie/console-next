// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError, api, session, unwrap } from "@console/api";

/** Only the error envelope's server-issued reference can identify a request. */
export function supportReferenceFromError(error: unknown): string | undefined {
  return error instanceof ApiError ? error.supportRef : undefined;
}

/** A crash report has its own server trace; an offline page has no reference until it reconnects. */
export type SupportReceipt = { support_ref: string; support_ref_at?: string };
export async function requestSupportReference(): Promise<SupportReceipt | undefined> {
  const beacon = (globalThis as { consoleErrorBeacon?: { reference(token?: string | null): Promise<SupportReceipt | null> } }).consoleErrorBeacon;
  return (await beacon?.reference(session.token)) ?? undefined;
}

/** The same disclosure serves platform operators and the customer account's diagnostic holders. */
export const resolveSupportReference = (value: string) => {
  const reference = value.trim().replace(/^ref\s+/, "");
  const params = { path: { reference } };
  return session.claims?.platform
    ? unwrap(api.GET("/api/platform/support-references/{reference}", { params }))
    : unwrap(api.GET("/api/v1/support-references/{reference}", { params }));
};
