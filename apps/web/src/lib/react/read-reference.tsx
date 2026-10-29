// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { SupportReference } from "./support-reference";

/** Never invent a server reference when the transport did not receive one. */
export function ReadReference({ error }: { error: unknown }) {
  return error instanceof ApiError ? <SupportReference reference={error.supportRef ?? error.operationId ?? error.requestKey} at={error.supportRefAt} compact={Boolean(error.supportRef)} /> : null;
}
