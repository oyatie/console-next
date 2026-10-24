// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import type { EntityDocument } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { Sheet } from "../../../ui/sheet/sheet";
import { attachRegistrationOriginal, ENTITY_READS } from "../api";
import { CertEvidence } from "./cert-evidence";
import { EntityError } from "./entity-error";

export function OriginalSheet({ entityId, registrationId, onClose }: { entityId: string; registrationId: string; onClose: () => void }) {
  const [doc, setDoc] = useState<EntityDocument | null>(null);
  const save = useCommand({
    run: (document: EntityDocument, key: string) => attachRegistrationOriginal(key, registrationId, document.id),
    invalidates: ENTITY_READS, settle: true, onSuccess: onClose,
    announce: () => t("nts.original.saved"),
  });
  return <Sheet open title={t("nts.attach")} onClose={onClose} pending={save.isPending}
    notice={<EntityError error={save.error} />}
    consequence={t("nts.original.consequence")}
    actions={<>
      <Button onClick={onClose}>{t("entityRecord.cancel")}</Button>
      <Button variant="primary" disabled={!doc || save.isPending} onClick={() => doc && save.mutate(doc)}>{t("nts.attach")}</Button>
    </>}
  >
    <CertEvidence entityId={entityId} doc={doc} onDoc={setDoc} original />
  </Sheet>;
}
