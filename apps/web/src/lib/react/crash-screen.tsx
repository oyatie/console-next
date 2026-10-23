// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import type { SupportReceipt } from "../support-reference";
import { useEffect, useState } from "react";
import { t } from "@console/i18n";
import { EmptyState } from "../../ui/empty-state";
import { Button } from "../../ui/button/button";
import { reloadPage } from "../chunk-guard";
import { requestSupportReference, supportReferenceFromError } from "../support-reference";
import { SupportReference } from "./support-reference";

export function CrashScreen({ error }: { error: unknown }) {
  const issued = supportReferenceFromError(error);
  const [reference, setReference] = useState<SupportReceipt>();
  useEffect(() => {
    if (supportReferenceFromError(error)) return;
    let current = true;
    void requestSupportReference().then((ref) => { if (current) setReference(ref); }, () => undefined);
    return () => { current = false; };
  }, [error]);
  return <main className="page"><EmptyState alert title={t("common.crashed.title")} reason={t("common.crashed.reason")}
    actions={<Button variant="primary" onClick={reloadPage}>{t("common.crashed.action")}</Button>}
    meta={<SupportReference reference={issued ?? reference?.support_ref} at={error instanceof ApiError ? error.supportRefAt : reference?.support_ref_at} />} /></main>;
}
