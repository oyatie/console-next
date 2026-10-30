// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { problemOf } from "../api";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { closeLifecycleCase, LIFECYCLE_CASE_READS, type CaseItem } from "../api/lifecycle-trail";
import { lifecycleTrailError } from "../present";
import { AttestSheet } from "./lifecycle-trail-attest";

export function CaseItemAction({ caseId, item }: { caseId: string; item: CaseItem }) {
  const [open, setOpen] = useState(false);
  if (!["OPEN", "BLOCKED", "PENDING_TRIGGER"].includes(item.status) || !item.owner_line || !item.completion_rule_ref) return null;
  const future = item.status === "PENDING_TRIGGER" || (item.opens_in_days !== null && item.opens_in_days > 0);
  return <><Button disabled={future} onClick={() => setOpen(true)}>{t("lifecycle.trail.attest")}</Button>
    {open && <AttestSheet caseId={caseId} item={item} onClose={() => setOpen(false)} />}</>;
}


export function CaseCloseAction({ id, items }: { id: string; items: readonly CaseItem[] }) {
  const command = useCommand({ run: () => closeLifecycleCase(id), invalidates: LIFECYCLE_CASE_READS });
  const first = items.find(item => item.blocks_close && ["OPEN", "BLOCKED", "PENDING_TRIGGER"].includes(item.status));
  return <><CommandError error={command.error} own={lifecycleTrailError}>
    {problemOf(command.error)?.code === "lifecycle.refuse.close_blocked" && first && <Link to="." hash={`item-${first.id}`}>{t("lifecycle.trail.openBlocking")}</Link>}
  </CommandError><Button aria-disabled={command.isPending} onClick={() => { if (!command.isPending) command.mutate(); }}>{t("lifecycle.trail.close")}</Button></>;
}
