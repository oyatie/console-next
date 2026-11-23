// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import type { SupportReceipt } from "../support-reference";
import { lazy, Suspense, useEffect, useState, type ComponentType } from "react";
import { loadBootCatalog, t } from "@console/i18n";
import { useActiveExperienceId } from "../../experience/dom";
import { EmptyState } from "../../ui/empty-state";
import { Button } from "../../ui/button/button-base";
import { localChunk, reloadPage } from "../chunk-guard";
import { requestSupportReference, supportReferenceFromError } from "../support-reference";
const SupportReference = lazy(() => localChunk(import("./support-reference")).then(m => ({ default: m.SupportReference }), () => ({ default: () => null })));
const CrashConsoleExtras = lazy<ComponentType>(() =>
  Promise.all([localChunk(import("./crash-console-extras")), loadBootCatalog()]).then(
    ([m]) => ({ default: m.CrashConsoleExtras }),
    () => ({ default: () => null }),
  ),
);

export function CrashScreen({ error }: { error: unknown }) {
  const experience = useActiveExperienceId();
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
    meta={
      <>
        <Suspense fallback={null}><SupportReference reference={issued ?? reference?.support_ref} at={error instanceof ApiError ? error.supportRefAt : reference?.support_ref_at} /></Suspense>
        {experience !== "baseline" ? <Suspense fallback={null}><CrashConsoleExtras /></Suspense> : null}
      </>
    } /></main>;
}
