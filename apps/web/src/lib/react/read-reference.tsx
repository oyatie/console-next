// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { t } from "@console/i18n";
import { SupportReference } from "./support-reference";

/** Never invent a server reference when the transport did not receive one. */
export function ReadReference({ error }: { error: unknown }) {
  const reference = error instanceof ApiError ? error.operationId ?? error.requestKey : undefined;
  if (error instanceof ApiError && error.supportRef) return <SupportReference reference={error.supportRef} at={error.supportRefAt} />;
  return reference ? <span className="muted">{t("common.operationId")} · <code>{reference}</code></span> : null;
}
