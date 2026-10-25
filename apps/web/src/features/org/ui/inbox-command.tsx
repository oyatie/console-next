// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { APPROVAL_ROLE, label } from "../../../lib/labels";
import { focusSoon } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { ORG_READS, unitsQuery } from "../../../reference/org/api";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { commitLabel } from "../../../ui/composer/actions";
import { changeCommands, changeQuery } from "../api";
import { EffectuateConsequence } from "./effectuate-consequence";

/** The inbox keeps its inline verbs; the record supplies the current step and application consequence. */
export function InboxCommand({ id, command }: { id: string; command: "approve" | "effectuate" }) {
  const detail = useQuery(changeQuery(id));
  const needsHeadcount = command === "effectuate" && detail.data?.proposal.some((op) => op.op === "REASSIGN_ORG_UNIT");
  const units = useQuery({ ...unitsQuery, staleTime: 0, refetchOnMount: "always", enabled: !!needsHeadcount });
  const headcount = units.isFetchedAfterMount && units.isSuccess ? units.data : undefined;
  const step = detail.data?.approvalSteps.find((s) => s.decision === "PENDING");
  const role = step ? label(APPROVAL_ROLE, step.roleKey) : "";
  const [open, setOpen] = useState(false);
  const action = useCommand({
    run: () => command === "approve" ? changeCommands(id).decide(step!.id, "APPROVED") : changeCommands(id).effectuate(),
    invalidates: ["/api/v1/me/action-inbox", ...ORG_READS, ...(command === "effectuate" ? ["/api/v1/employees", "/api/v1/employment-assignments"] as const : [])],
    onSuccess: () => {
      setOpen(false);
      focusSoon("inbox-title");
    },
    announce: command === "approve" ? () => t("org.change.decided.APPROVED", { role }) : undefined,
  });
  const disabled = !detail.isSuccess || detail.isFetching || action.isPending || (!!needsHeadcount && (!headcount || units.isFetching));
  if (command === "approve") return <div className="row">
    {step && <Chip tone="info">{t("orgChange.turn", { role })}</Chip>}
    <Button variant="primary" disabled={disabled || !step} onClick={() => action.mutate(undefined)}>{commitLabel({ kind: "orgChange", mode: "approve" })}</Button>
    <CommandError error={action.error} />
  </div>;
  return <div className="form">
    <QueryState q={detail}>{(d) => <EffectuateConsequence d={d} headcount={headcount} />}</QueryState>
    <Button variant="primary" disabled={disabled} onClick={() => setOpen(true)}>{t("org.change.effectuate")}</Button>
    <Dialog open={open} read title={t("org.change.effectuate")} onClose={() => setOpen(false)}>
      <QueryState q={detail}>{(d) => <EffectuateConsequence d={d} headcount={headcount} />}</QueryState>
      <CommandError error={action.error} />
      <div className="form__actions">
        <Button onClick={() => setOpen(false)}>{t("composer.dismiss")}</Button>
        <Button variant="primary" disabled={disabled} onClick={() => action.mutate(undefined)}>{commitLabel({ kind: "orgChange", mode: "apply" })}</Button>
      </div>
    </Dialog>
  </div>;
}
